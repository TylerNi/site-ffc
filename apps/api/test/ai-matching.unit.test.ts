import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaService } from '../src/database';
import {
  AiMatchingService,
  FUZZY_ACCEPT_THRESHOLD,
  normalizeManufacturer,
  normalizeModelNumber,
} from '../src/modules/ai/ai-matching.service';
import { createTestClient } from './helpers';

/**
 * Correspondance extraction → catalogue (tâche 17), sur la base de test
 * seedée : normalisation, exacte, alias, floue pg_trgm, variantes par
 * dimensions. Le service parle directement à PostgreSQL (index trigram GIN).
 */
describe('Correspondance IA (tâche 17)', () => {
  let prisma: PrismaClient;
  let matching: AiMatchingService;

  beforeAll(() => {
    prisma = createTestClient();
    matching = new AiMatchingService(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /* --------------------------- Normalisation ----------------------------- */

  it('normalise casse, tirets, espaces et ponctuation des numéros de modèle', () => {
    expect(normalizeModelNumber('G61MPV-36B-070')).toBe('G61MPV36B070');
    expect(normalizeModelNumber('g61mpv 36b 070')).toBe('G61MPV36B070');
    expect(normalizeModelNumber('  59.sc5 ')).toBe('59SC5');
    expect(normalizeModelNumber('Constructo 1.5')).toBe('CONSTRUCTO15');
    expect(normalizeManufacturer('Lennox Industries inc.')).toBe('LENNOXINDUSTRIESINC');
  });

  /* -------------------------- Exacte et alias ---------------------------- */

  it('correspondance EXACTE malgré casse et séparateurs (« g61-mpv » → Lennox G61MPV)', async () => {
    const outcome = await matching.matchEquipment('Lennox', 'g61-mpv');
    expect(outcome.result.kind).toBe('exact');
    expect(outcome.matchedEquipmentModelId).not.toBeNull();
    const model = await prisma.equipmentModel.findUniqueOrThrow({
      where: { id: outcome.matchedEquipmentModelId! },
    });
    expect(model.modelNumber).toBe('G61MPV');
  });

  it('correspondance par ALIAS, graphie normalisée (« gmvc 960603 bn » → Goodman GMVC96)', async () => {
    const outcome = await matching.matchEquipment(null, 'gmvc 960603 bn');
    expect(outcome.result.kind).toBe('alias');
    const model = await prisma.equipmentModel.findUniqueOrThrow({
      where: { id: outcome.matchedEquipmentModelId! },
    });
    expect(model.modelNumber).toBe('GMVC96');
  });

  it('sans numéro de modèle : aucune correspondance, aucun candidat', async () => {
    const outcome = await matching.matchEquipment('Lennox', null);
    expect(outcome.matchedEquipmentModelId).toBeNull();
    expect(outcome.result).toEqual({ kind: 'none', score: null, candidates: [] });
  });

  /* ------------------------------- Floue --------------------------------- */

  it('floue pg_trgm : faute de frappe légère → meilleure candidate avec score', async () => {
    // « TUH1B080A942lA » (l au lieu de 1) ressemble fort à l'alias Trane TUH1B080A9421A.
    const outcome = await matching.matchEquipment('Trane', 'TUH1B080A942lA');
    expect(outcome.result.candidates.length).toBeGreaterThan(0);
    expect(outcome.result.candidates[0]!.modelNumber).toBe('XR95');
    expect(outcome.result.candidates[0]!.similarity).toBeGreaterThan(0.5);
    if (outcome.result.candidates[0]!.similarity >= FUZZY_ACCEPT_THRESHOLD) {
      expect(outcome.result.kind).toBe('fuzzy');
      expect(outcome.matchedEquipmentModelId).toBe(outcome.result.candidates[0]!.equipmentModelId);
    } else {
      expect(outcome.result.kind).toBe('none');
      expect(outcome.matchedEquipmentModelId).toBeNull();
    }
  });

  it('numéro sans aucun rapport → kind none, pas de candidates farfelues', async () => {
    const outcome = await matching.matchEquipment('Bosch', 'ZZZZ-9999-QQQQ');
    expect(outcome.matchedEquipmentModelId).toBeNull();
    expect(outcome.result.kind).toBe('none');
    expect(outcome.result.candidates).toEqual([]);
  });

  /* -------------------- Variantes par dimensions (mode B) ----------------- */

  it('16x25x1 + MERV 11 → variantes actives, MERV exact en tête', async () => {
    const variants = await matching.matchVariantsByDimensions(
      { widthIn: 16, heightIn: 25, depthIn: 1, confidence: 0.9 },
      11,
    );
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) expect(variant.nominalLabel).toBe('16x25x1');
    expect(variants[0]!.merv).toBe(11);
    expect(variants[0]!.mervMatches).toBe(true);
    expect(variants[0]!.packSize).toBe(1); // boîtes croissantes après le MERV
  });

  it('dimensions RÉELLES (15,75 × 24,75 × 0,75) → mêmes variantes nominales 16x25x1', async () => {
    const variants = await matching.matchVariantsByDimensions(
      { widthIn: 15.75, heightIn: 24.75, depthIn: 0.75, confidence: 0.9 },
      null,
    );
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((variant) => variant.nominalLabel === '16x25x1')).toBe(true);
  });

  it('orientation interchangeable : 25x16x1 ≡ 16x25x1', async () => {
    const variants = await matching.matchVariantsByDimensions(
      { widthIn: 25, heightIn: 16, depthIn: 1, confidence: 0.9 },
      null,
    );
    expect(variants.length).toBeGreaterThan(0);
    expect(variants[0]!.nominalLabel).toBe('16x25x1');
  });

  it('largeur ou hauteur manquante → aucune variante (profondeur seule inutile)', async () => {
    expect(
      await matching.matchVariantsByDimensions(
        { widthIn: 16, heightIn: null, depthIn: 1, confidence: 0.5 },
        11,
      ),
    ).toEqual([]);
  });

  it('taille inconnue du catalogue → aucune variante', async () => {
    expect(
      await matching.matchVariantsByDimensions(
        { widthIn: 13, heightIn: 21.5, depthIn: 2, confidence: 0.9 },
        8,
      ),
    ).toEqual([]);
  });

  /* ------------------- Variantes du modèle apparié (mode A) ---------------- */

  it('variantes compatibles du modèle apparié (Lennox G61MPV → 16x25x5)', async () => {
    const model = await prisma.equipmentModel.findFirstOrThrow({
      where: { manufacturer: 'Lennox', modelNumber: 'G61MPV' },
    });
    const variants = await matching.variantsForEquipmentModel(model.id, 11);
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) expect(variant.nominalLabel).toBe('16x25x5');
    expect(variants[0]!.merv).toBe(11);
    expect(variants[0]!.mervMatches).toBe(true);
  });
});
