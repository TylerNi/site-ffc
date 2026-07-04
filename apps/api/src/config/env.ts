import { z } from 'zod';

/**
 * Schéma des variables d'environnement, validé au démarrage par
 * `ConfigModule` : l'application refuse de démarrer si une variable
 * est manquante ou invalide.
 *
 * Les secrets ont des valeurs PAR DÉFAUT DE DÉVELOPPEMENT pour que
 * `pnpm dev` et les tests fonctionnent sans configuration ; en
 * production, ces valeurs par défaut sont REFUSÉES (voir superRefine).
 */

/** Secret JWT de développement — refusé en production. */
export const DEV_JWT_ACCESS_SECRET = 'dev-secret-jwt-ffc-ne-jamais-utiliser-en-production';

/** Clé AES-256-GCM de développement (32 octets, base64) — refusée en production. */
export const DEV_APP_ENCRYPTION_KEY = Buffer.from(
  'ffc-dev-cle-de-chiffrement-32-ok',
  'utf8',
).toString('base64');

export const envSchema = z
  .object({
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

    /* ------------------------- Authentification ------------------------- */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET doit faire au moins 32 caractères')
      .default(DEV_JWT_ACCESS_SECRET)
      .describe('Secret HMAC des access tokens JWT (HS256)'),
    JWT_ACCESS_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(900)
      .describe('Durée de vie des access tokens (15 min par défaut)'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe('Durée de vie des refresh tokens opaques'),
    APP_ENCRYPTION_KEY: z
      .string()
      .default(DEV_APP_ENCRYPTION_KEY)
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'APP_ENCRYPTION_KEY doit être 32 octets encodés en base64')
      .describe('Clé AES-256-GCM des secrets applicatifs (secrets TOTP)'),
    APP_WEB_URL: z
      .url()
      .default('http://localhost:3000')
      .describe('URL de la vitrine web — liens des courriels (vérification, réinitialisation)'),
    AUTH_COOKIE_DOMAIN: z
      .string()
      .optional()
      .describe('Domaine du cookie de refresh (ex. .filtrationmontreal.com) ; absent en local'),
    TRUST_PROXY_HOPS: z.coerce
      .number()
      .int()
      .min(0)
      .max(10)
      .default(0)
      .describe('Nombre de proxys de confiance devant l’API (Cloudflare + ALB = 2 en prod)'),
    AUTH_THROTTLE_DISABLED: z
      .enum(['0', '1'])
      .default('0')
      .describe('1 = désactive le rate limiting (réservé aux tests automatisés)'),

    /* ------------------------ Connexions sociales ----------------------- */
    GOOGLE_CLIENT_IDS: z
      .string()
      .optional()
      .describe('Client IDs OAuth Google acceptés comme audience (séparés par des virgules)'),
    APPLE_CLIENT_IDS: z
      .string()
      .optional()
      .describe('Identifiants Apple (Services ID web + bundle IDs iOS), séparés par des virgules'),

    /* ------------------------------ Courriel ---------------------------- */
    MAIL_DRIVER: z
      .enum(['log', 'ses'])
      .default('log')
      .describe('log = console + boîte mémoire (dev/test) ; ses = envoi réel via AWS SES'),
    MAIL_FROM: z
      .string()
      .default('Filtration Montréal <no-reply@filtrationmontreal.com>')
      .describe('Expéditeur des courriels transactionnels'),
    AWS_REGION: z.string().default('ca-central-1').describe('Région AWS (SES, S3…)'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.JWT_ACCESS_SECRET === DEV_JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'Le secret JWT de développement est interdit en production',
      });
    }
    if (env.APP_ENCRYPTION_KEY === DEV_APP_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENCRYPTION_KEY'],
        message: 'La clé de chiffrement de développement est interdite en production',
      });
    }
    if (env.MAIL_DRIVER !== 'ses') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_DRIVER'],
        message: 'MAIL_DRIVER doit être « ses » en production (courriels de sécurité obligatoires)',
      });
    }
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

/** « id1,id2 » → ['id1', 'id2'] (client IDs OAuth). */
export function parseClientIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
