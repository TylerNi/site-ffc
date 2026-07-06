import { describe, expect, it, vi } from 'vitest';
import {
  BigCommerceApiError,
  BigCommerceClient,
  bigCommerceClientFromEnv,
} from '../src/bigcommerce/client';

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

/**
 * Client BigCommerce (tâche 08 §1/contraintes) : pagination v3 et retries sur
 * 429/5xx sans dépasser les limites de débit. `fetchImpl` injecté — aucun
 * réseau réel dans les tests.
 */
describe('bigcommerce/client', () => {
  it("parcourt toutes les pages jusqu'à current_page >= total_pages", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const data = page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
      return jsonResponse({ data, meta: { pagination: { current_page: page, total_pages: 2 } } });
    });

    const client = new BigCommerceClient({
      storeHash: 'abc',
      accessToken: 'tok',
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    const items = await client.getPaginated<{ id: number }>('/catalog/products');

    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
  });

  it('réessaie sur 429 puis réussit', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({}, { status: 429, headers: { 'X-Rate-Limit-Time-Reset-Ms': '1' } });
      }
      return jsonResponse({
        data: [{ id: 1 }],
        meta: { pagination: { current_page: 1, total_pages: 1 } },
      });
    });

    const client = new BigCommerceClient({
      storeHash: 'abc',
      accessToken: 'tok',
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    const items = await client.getPaginated<{ id: number }>('/catalog/products');

    expect(items).toEqual([{ id: 1 }]);
    expect(attempts).toBe(2);
  });

  it('abandonne après le nombre maximal de tentatives (erreur non 429/5xx immédiate)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, { status: 401 }));
    const client = new BigCommerceClient({
      storeHash: 'abc',
      accessToken: 'tok',
      fetchImpl,
      minRequestIntervalMs: 0,
    });

    await expect(client.getPaginated('/catalog/products')).rejects.toBeInstanceOf(
      BigCommerceApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 401 non réessayable
  });

  it('bigCommerceClientFromEnv exige les variables des deux vitrines', () => {
    expect(() => bigCommerceClientFromEnv('en', {})).toThrow(/BIGCOMMERCE_STORE_HASH_EN/);
  });
});
