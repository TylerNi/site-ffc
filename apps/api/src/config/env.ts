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
    APP_ADMIN_URL: z
      .url()
      .default('http://localhost:3001')
      .describe(
        'URL de l’administration — liens des courriels d’invitation du personnel (tâche 09)',
      ),
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

    /* ------------------------- Paiements (Stripe) ----------------------- */
    // Chaîne vide ≡ absente : permet de neutraliser explicitement une
    // variable (tests) sans retirer la ligne du .env.
    STRIPE_SECRET_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .startsWith('sk_', 'STRIPE_SECRET_KEY doit commencer par sk_')
        .optional()
        .describe('Clé secrète Stripe (sk_test_… en dev). Absente : checkout désactivé (503).'),
    ),
    STRIPE_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .startsWith('whsec_', 'STRIPE_WEBHOOK_SECRET doit commencer par whsec_')
        .optional()
        .describe('Secret de signature du endpoint webhook (stripe listen en dev).'),
    ),

    /* ------------------------- Files (BullMQ/Redis) --------------------- */
    REDIS_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^rediss?:\/\//, 'REDIS_URL doit être une URL redis:// ou rediss://')
        .optional()
        .describe(
          'Connexion Redis des files BullMQ (webhooks Stripe). Absente : traitement immédiat dans le processus API (dev/test seulement).',
        ),
    ),

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

    /* ------------------------- Factures (S3, tâche 12) ------------------ */
    // Bucket privé des factures PDF. Absent (dev/test) : stockage mémoire
    // (aucun réseau). Obligatoire en production (superRefine).
    S3_INVOICES_BUCKET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .optional()
        .describe(
          'Bucket S3 privé des factures PDF (invoices). Absent : stockage mémoire dev/test.',
        ),
    ),
    PUBLIC_API_URL: z
      .url()
      .default('http://localhost:4000')
      .describe('URL publique de l’API — liens de téléchargement de facture dans les courriels'),
    INVOICE_DOWNLOAD_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 366)
      .default(24 * 30)
      .describe('Durée de validité des liens signés de téléchargement de facture (30 jours)'),

    /* ------------------------ ShipStation (tâche 13) -------------------- */
    // Sans clé : la synchronisation reste EN FILE (rien n'est perdu), les
    // appels réseau sont refusés proprement. Obligatoire en production.
    SHIPSTATION_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Clé API ShipStation (authentification Basic).'),
    ),
    SHIPSTATION_API_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Secret API ShipStation (authentification Basic).'),
    ),
    SHIPSTATION_BASE_URL: z
      .url()
      .default('https://ssapi.shipstation.com')
      .describe('Racine de l’API ShipStation V1'),
    SHIPSTATION_STORE_ID: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe('Identifiant de la boutique personnalisée ShipStation (advancedOptions.storeId)'),
    ),
    SHIPSTATION_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .min(16, 'SHIPSTATION_WEBHOOK_SECRET doit faire au moins 16 caractères')
        .optional()
        .describe(
          'Secret partagé du webhook ShipStation (jeton dans l’URL — ShipStation ne signe pas ses appels).',
        ),
    ),
    SHIPSTATION_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(240)
      .default(40)
      .describe('Limite de débit de l’API ShipStation (40 requêtes/minute par compte).'),

    /* -------------------- Repérage transporteurs (tâche 14) ------------- */
    // Comptes PROPRES par transporteur (checklist tâche 01). Tous optionnels,
    // même en production : un adapter sans clés est simplement inactif — les
    // colis gardent leur lien de repérage public (tâche 13) et la file de
    // polling reste intacte jusqu'à l'arrivée des accès.
    CANADA_POST_API_USERNAME: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Clé API Postes Canada (programme développeur).'),
    ),
    CANADA_POST_API_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Secret API Postes Canada.'),
    ),
    CANADA_POST_BASE_URL: z
      .url()
      .default('https://soa-gw.canadapost.ca')
      .describe('Passerelle Postes Canada (ct.soa-gw.canadapost.ca en développement).'),
    NATIONEX_CUSTOMER_ID: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Numéro de client Nationex (authentification Basic).'),
    ),
    NATIONEX_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Clé API Nationex.'),
    ),
    NATIONEX_BASE_URL: z
      .url()
      .default('https://api.nationex.com')
      .describe('Racine de l’API REST Nationex.'),
    CANPAR_API_USERNAME: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Utilisateur du service web Canpar.'),
    ),
    CANPAR_API_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Mot de passe du service web Canpar.'),
    ),
    CANPAR_BASE_URL: z
      .url()
      .default('https://canship.canpar.com')
      .describe('Racine des services web Canpar (sandbox : sandbox.canpar.com).'),
    PUROLATOR_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Clé API Purolator E-Ship (selon l’accès disponible).'),
    ),
    PUROLATOR_API_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Mot de passe API Purolator.'),
    ),
    PUROLATOR_BASE_URL: z
      .url()
      .default('https://webservices.purolator.com')
      .describe('Racine des services web Purolator (devwebservices… en développement).'),

    /* ------------------- Catalogue admin (tâche 10) ---------------------- */
    // Bucket S3 des images produit — le MÊME que l'import BigCommerce
    // (tâche 08 : `S3_BUCKET_PRODUCT_IMAGES`, provisionné tâche 03). Absent
    // (dev/test) : téléversement simulé en mémoire (aucun réseau).
    // OBLIGATOIRE en production.
    S3_BUCKET_PRODUCT_IMAGES: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .optional()
        .describe(
          'Bucket S3 public/CDN des images produit. Absent : téléversement simulé (dev/test).',
        ),
    ),
    // Secret partagé avec la vitrine web (APP_WEB_URL + /api/revalidate) :
    // l'admin déclenche la revalidation ISR à la publication/dépublication
    // d'un produit (tâche 07/10). OBLIGATOIRE en production.
    REVALIDATE_SECRET: z
      .string()
      .default('dev-secret-revalidate-ffc-ne-jamais-utiliser-en-production')
      .describe('Secret partagé avec la vitrine web pour POST /api/revalidate'),
    // Destinataire des alertes de stock bas (tâche 10). OBLIGATOIRE en production.
    INVENTORY_ALERT_EMAIL: z
      .string()
      .default('inventaire@filtrationmontreal.com')
      .describe('Adresse courriel de l’équipe notifiée quand un seuil de stock est franchi'),

    /* --------------------- IA : pipeline de vision (tâche 17) ----------- */
    // Driver du fournisseur de vision. `log` = fixture déterministe (dev/test,
    // aucun réseau). En production, `log` est REFUSÉ (superRefine) : des faux
    // résultats en prod seraient pires qu'une panne — sans clé API, les
    // endpoints répondent 503 proprement (pattern Stripe, tâche 11).
    AI_VISION_DRIVER: z
      .enum(['log', 'anthropic', 'openai'])
      .default('log')
      .describe('Fournisseur de vision : log (fixture dev/test) | anthropic | openai.'),
    ANTHROPIC_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Clé API Anthropic (Claude). Absente : IA en 503.'),
    ),
    ANTHROPIC_VISION_MODEL: z
      .string()
      .default('claude-opus-4-8')
      .describe('Modèle Claude utilisé pour la vision (banc d’essai : ai:bench).'),
    OPENAI_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional().describe('Clé API OpenAI (GPT). Absente : IA en 503.'),
    ),
    OPENAI_VISION_MODEL: z
      .string()
      .default('gpt-5.1')
      .describe('Modèle GPT utilisé pour la vision (banc d’essai : ai:bench).'),
    // Bucket S3 PRIVÉ des photos client (cycle de vie 30 jours côté S3 en
    // filet — la purge applicative reste la source de vérité, Loi 25).
    // Absent (dev/test) : stockage mémoire. OBLIGATOIRE en production.
    S3_AI_PHOTOS_BUCKET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .optional()
        .describe('Bucket S3 privé des photos IA (ai-photos). Absent : mémoire dev/test.'),
    ),

    /* ----------------------- Push Expo (tâche 14) ----------------------- */
    PUSH_DRIVER: z
      .enum(['log', 'expo'])
      .default('log')
      .describe('log = boîte mémoire + console (dev/test) ; expo = envoi réel via Expo Push.'),
    EXPO_ACCESS_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .optional()
        .describe('Jeton d’accès Expo (« Enhanced Security for Push Notifications »).'),
    ),
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
    if (!env.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'STRIPE_SECRET_KEY est obligatoire en production (checkout)',
      });
    }
    if (!env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'STRIPE_WEBHOOK_SECRET est obligatoire en production (webhooks signés)',
      });
    }
    if (!env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'REDIS_URL est obligatoire en production (files BullMQ)',
      });
    }
    if (!env.S3_INVOICES_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_INVOICES_BUCKET'],
        message: 'S3_INVOICES_BUCKET est obligatoire en production (stockage des factures PDF)',
      });
    }
    if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SHIPSTATION_API_KEY'],
        message:
          'SHIPSTATION_API_KEY et SHIPSTATION_API_SECRET sont obligatoires en production (poussée des commandes)',
      });
    }
    if (!env.SHIPSTATION_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SHIPSTATION_WEBHOOK_SECRET'],
        message:
          'SHIPSTATION_WEBHOOK_SECRET est obligatoire en production (le webhook doit être authentifié)',
      });
    }
    if (!env.S3_BUCKET_PRODUCT_IMAGES) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET_PRODUCT_IMAGES'],
        message: 'S3_BUCKET_PRODUCT_IMAGES est obligatoire en production (images produit)',
      });
    }
    if (env.REVALIDATE_SECRET === 'dev-secret-revalidate-ffc-ne-jamais-utiliser-en-production') {
      ctx.addIssue({
        code: 'custom',
        path: ['REVALIDATE_SECRET'],
        message: 'Le secret de revalidation de développement est interdit en production',
      });
    }
    if (env.AI_VISION_DRIVER === 'log') {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_VISION_DRIVER'],
        message:
          'AI_VISION_DRIVER doit être « anthropic » ou « openai » en production (le driver de fixtures fabriquerait de faux résultats)',
      });
    }
    if (!env.S3_AI_PHOTOS_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_AI_PHOTOS_BUCKET'],
        message:
          'S3_AI_PHOTOS_BUCKET est obligatoire en production (photos client — jamais en mémoire)',
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
