import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://ffc:ffc@localhost:5432/ffc_test?schema=public';

/**
 * URL de la base de TEST (jamais ffc_dev : le globalSetup fait un migrate
 * reset destructif). Ordre : env TEST_DATABASE_URL → .env local → défaut
 * docker-compose.
 */
export function getTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  try {
    const env = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    const value = env.match(/^TEST_DATABASE_URL=(.+)$/m)?.[1];
    if (value) return value.trim();
  } catch {
    // pas de .env local (CI) — on retombe sur le défaut
  }
  return DEFAULT_TEST_DATABASE_URL;
}

/** Client Prisma pointé explicitement sur la base de test. */
export function createTestClient(options?: { connectionLimit?: number }): PrismaClient {
  let url = getTestDatabaseUrl();
  if (options?.connectionLimit) {
    url += `${url.includes('?') ? '&' : '?'}connection_limit=${options.connectionLimit}`;
  }
  return new PrismaClient({ datasourceUrl: url });
}
