/**
 * Client HTTP minimal pour l'API BigCommerce (v3) : pagination, respect des
 * limites de débit (429 + en-tête `X-Rate-Limit-Time-Reset-Ms`), retries avec
 * recul exponentiel. Lecture seule — aucune méthode d'écriture n'est exposée
 * (contrainte de la tâche 08 : ne jamais modifier les vitrines BigCommerce).
 *
 * `fetchImpl` est injectable pour les tests (aucune dépendance HTTP externe
 * ajoutée : `fetch` global de Node, comme le reste du dépôt).
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BigCommerceClientOptions {
  storeHash: string;
  accessToken: string;
  /** Défaut : API BigCommerce réelle. Surchageable pour les tests. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  /** Délai minimum entre deux requêtes (throttling proactif), en ms. */
  minRequestIntervalMs?: number;
}

export class BigCommerceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'BigCommerceApiError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BigCommerceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly minRequestIntervalMs: number;
  private lastRequestAt = 0;

  constructor(private readonly options: BigCommerceClientOptions) {
    this.baseUrl = options.baseUrl ?? `https://api.bigcommerce.com/stores/${options.storeHash}/v3`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 5;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 150;
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minRequestIntervalMs) {
      await sleep(this.minRequestIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  /** Une requête GET unique, avec retries sur 429/5xx. */
  private async get(path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          'X-Auth-Token': this.options.accessToken,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        return response.json();
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new BigCommerceApiError(
          `BigCommerce ${response.status} sur ${path}`,
          response.status,
          path,
        );
      }

      const resetMs = Number(response.headers.get('X-Rate-Limit-Time-Reset-Ms'));
      const backoffMs = Number.isFinite(resetMs) && resetMs > 0 ? resetMs : 500 * 2 ** attempt;
      await sleep(backoffMs);
      attempt += 1;
    }
  }

  /**
   * Parcourt toutes les pages d'une ressource v3 (`meta.pagination`) et
   * retourne la liste complète.
   */
  async getPaginated<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    const limit = params.limit ?? '250';

    for (;;) {
      const query = new URLSearchParams({ ...params, limit, page: String(page) });
      const body = (await this.get(`${path}?${query.toString()}`)) as {
        data: T[];
        meta?: { pagination?: { current_page: number; total_pages: number } };
      };
      items.push(...body.data);

      const pagination = body.meta?.pagination;
      if (!pagination || pagination.current_page >= pagination.total_pages) break;
      page += 1;
    }

    return items;
  }
}

/** Construit un client à partir des variables d'environnement d'une vitrine. */
export function bigCommerceClientFromEnv(
  store: 'en' | 'fr',
  env: NodeJS.ProcessEnv = process.env,
): BigCommerceClient {
  const suffix = store.toUpperCase();
  const storeHash = env[`BIGCOMMERCE_STORE_HASH_${suffix}`];
  const accessToken = env[`BIGCOMMERCE_ACCESS_TOKEN_${suffix}`];
  if (!storeHash || !accessToken) {
    throw new Error(
      `Variables manquantes : BIGCOMMERCE_STORE_HASH_${suffix} / BIGCOMMERCE_ACCESS_TOKEN_${suffix}`,
    );
  }
  return new BigCommerceClient({ storeHash, accessToken });
}
