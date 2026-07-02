#!/usr/bin/env node
// Étape de migration de base de données, exécutée par le pipeline CI/CD comme
// une TÂCHE ECS PONCTUELLE et CONTRÔLÉE, AVANT le basculement du service
// (voir .github/workflows/deploy.yml).
//
// Tant que Prisma n'existe pas (arrive en tâche 04), ce script est un no-op
// SÛR : il se termine avec succès pour ne pas bloquer le déploiement, tout en
// journalisant clairement l'état. Dès que `apps/api/prisma/schema.prisma`
// existe et que Prisma est une dépendance de production, il applique les
// migrations avec `prisma migrate deploy` (non interactif, idempotent).
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = join(scriptDir, '..');
const schemaPath = join(apiDir, 'prisma', 'schema.prisma');

if (!existsSync(schemaPath)) {
  console.log(
    '[migrate] Aucun schéma Prisma (prisma/schema.prisma) — rien à migrer. ' +
      'Étape ignorée (le schéma arrive en tâche 04). Sortie 0.',
  );
  process.exit(0);
}

const prismaBin = join(
  apiDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
);

console.log('[migrate] Application des migrations : prisma migrate deploy…');
try {
  execFileSync(prismaBin, ['migrate', 'deploy'], { stdio: 'inherit', cwd: apiDir });
  console.log('[migrate] Migrations appliquées avec succès.');
} catch (error) {
  console.error('[migrate] Échec des migrations — déploiement interrompu.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
