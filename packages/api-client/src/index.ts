import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/schema';

export type { paths } from './generated/schema';

export interface ApiClientOptions extends ClientOptions {
  /** URL de base de l'API, ex. `http://localhost:4000`. */
  baseUrl: string;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Client HTTP typé, généré depuis l'OpenAPI de l'API NestJS.
 * Régénérer après un changement d'API : `pnpm generate:client` (racine).
 */
export function createApiClient(options: ApiClientOptions) {
  return createClient<paths>(options);
}
