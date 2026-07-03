/**
 * Prépare la base de TEST avant la suite vitest :
 *   1. prisma generate (client à jour),
 *   2. base ffc_test créée si absente, schéma public REJOUÉ DE ZÉRO
 *      (drop schema + prisma migrate deploy) — la chaîne complète de
 *      migrations est validée à chaque exécution,
 *   3. seed complet (les tests s'appuient sur le catalogue seedé).
 *
 * Garde-fou : refuse toute base dont le nom ne contient pas « test » —
 * impossible de pointer les tests (destructifs) sur ffc_dev ou pire.
 *
 * Prérequis local : `docker compose up -d postgres` (voir docker-compose.yml)
 * et `pnpm build --filter @ffc/core` (le seed importe @ffc/core).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getTestDatabaseUrl } from './helpers';

const require = createRequire(__filename);

function runPrisma(args: string[], databaseUrl: string): void {
  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

/** Crée la base de test si elle n'existe pas (connexion à la base `postgres`). */
async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\//, '');

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    const exists = await admin.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM pg_database WHERE datname = ${databaseName}`;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Impossible de joindre PostgreSQL (${adminUrl}).\n` +
        `Démarrez la base locale : docker compose up -d postgres\n` +
        `Cause : ${message}`,
    );
  } finally {
    await admin.$disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl = getTestDatabaseUrl();

  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.includes('test')) {
    throw new Error(
      `Refus : les tests réinitialisent la base et « ${databaseName} » ne ressemble pas ` +
        `à une base de test. Réglez TEST_DATABASE_URL sur une base dédiée (ex. ffc_test).`,
    );
  }

  runPrisma(['generate'], databaseUrl);

  await ensureDatabaseExists(databaseUrl);

  // Repart de zéro puis rejoue TOUTES les migrations (equivalent contrôlé de
  // « migrate reset », sans commande destructive générique).
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }

  runPrisma(['migrate', 'deploy'], databaseUrl);

  // Seed programmatique (import dynamique APRÈS prisma generate).
  const { seed } = await import('../prisma/seed');
  const seedClient = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await seed(seedClient);
  } finally {
    await seedClient.$disconnect();
  }
}
