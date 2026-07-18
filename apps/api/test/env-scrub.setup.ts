/**
 * Purge de l'environnement AVANT l'import des modules applicatifs.
 *
 * Le processus principal de vitest charge le .env réel du développeur (le
 * dotenv embarqué de @prisma/client, importé par global-setup.ts) et les
 * workers en héritent : sans purge, les vraies clés (ShipStation, Postes
 * Canada…) se figeraient dans la config validée au premier import de
 * l'AppModule — les tests frapperaient les API réelles (observé le
 * 2026-07-18 : GET /orders ShipStation depuis la suite).
 *
 * La liste purgée est DÉRIVÉE du schéma zod : toute variable ajoutée au
 * schéma est automatiquement couverte. Les helpers de test reposent leurs
 * valeurs via process.env APRÈS cette purge (createTestApp).
 */
import { envSchema } from '../src/config/env';
import { getTestDatabaseUrl } from './helpers';

const testDatabaseUrl = getTestDatabaseUrl();

const KEEP = new Set(['NODE_ENV']);
for (const key of Object.keys(envSchema.shape)) {
  if (!KEEP.has(key)) delete process.env[key];
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('BIGCOMMERCE_')) delete process.env[key];
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseUrl;
