import { z } from 'zod';

/**
 * Schéma des variables d'environnement, validé au démarrage par
 * `ConfigModule` : l'application refuse de démarrer si une variable
 * est manquante ou invalide.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_CORS_ORIGINS: z
    .string()
    .min(1)
    .default('http://localhost:3000,http://localhost:3001')
    .describe('Origines autorisées (CORS), séparées par des virgules'),
  DATABASE_URL: z
    .url()
    .startsWith('postgresql://', 'DATABASE_URL doit être une URL postgresql://')
    .describe('Chaîne de connexion PostgreSQL (RDS en production, Docker en local)'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Configuration invalide — démarrage refusé :\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function parseCorsOrigins(origins: string): string[] {
  return origins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
