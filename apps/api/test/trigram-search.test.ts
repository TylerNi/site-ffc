import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient } from './helpers';

/**
 * Critère d'acceptation : recherche trigram (pg_trgm) fonctionnelle,
 * démontrée sur les données seedées.
 */
describe('recherche trigram (pg_trgm) sur les seeds', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('l’extension pg_trgm est active', async () => {
    const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`;
    expect(rows).toHaveLength(1);
  });

  it('« furnance filter » (faute de frappe) retrouve les produits anglais', async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; score: number }>>`
      SELECT name, word_similarity('furnance filter', name)::float AS score
      FROM product_translations
      WHERE locale = 'en' AND word_similarity('furnance filter', name) > 0.4
      ORDER BY score DESC
      LIMIT 5`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toMatch(/Furnace Filter/i);
  });

  it('« fournais » retrouve les produits français malgré la troncature', async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; score: number }>>`
      SELECT name, word_similarity('fournais', name)::float AS score
      FROM product_translations
      WHERE locale = 'fr' AND word_similarity('fournais', name) > 0.4
      ORDER BY score DESC
      LIMIT 5`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toMatch(/fournaise/i);
  });

  it('« G61MP » (numéro partiel) retrouve le modèle Lennox G61MPV', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ manufacturer: string; model_number: string; score: number }>
    >`
      SELECT manufacturer, model_number, similarity(model_number, 'G61MP')::float AS score
      FROM equipment_models
      WHERE model_number % 'G61MP'
      ORDER BY score DESC
      LIMIT 3`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.model_number).toBe('G61MPV');
    expect(rows[0]?.manufacturer).toBe('Lennox');
  });

  it('la recherche d’alias exacte utilise le tableau (« G61MPV-36B-070 »)', async () => {
    const rows = await prisma.$queryRaw<Array<{ model_number: string }>>`
      SELECT model_number FROM equipment_models WHERE aliases @> ARRAY['G61MPV-36B-070']`;
    expect(rows.map((r) => r.model_number)).toContain('G61MPV');
  });

  it('l’index GIN trigram est utilisé par l’opérateur % (plan d’exécution)', async () => {
    // Le planificateur préfère un seq scan sur ~80 lignes : on le désactive
    // pour PROUVER que l'index est utilisable, comme il le sera à l'échelle.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe<Array<Record<string, string>>>(
        `EXPLAIN SELECT id FROM product_translations WHERE name % 'PureFlow MERV 8'`,
      );
    });
    const planText = plan.map((row) => Object.values(row)[0]).join('\n');
    expect(planText).toContain('product_translations_name_trgm_idx');
  });

  it('le catalogue seedé est complet (~40 produits, 3 marques, traductions fr+en)', async () => {
    expect(await prisma.product.count()).toBe(40);
    expect(await prisma.brand.count()).toBe(3);
    expect(await prisma.productTranslation.count({ where: { locale: 'fr' } })).toBe(40);
    expect(await prisma.productTranslation.count({ where: { locale: 'en' } })).toBe(40);
    expect(await prisma.productVariant.count()).toBeGreaterThanOrEqual(100);
  });
});
