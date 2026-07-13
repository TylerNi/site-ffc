import { parseAiExtractionEnvelope, type VisionExtraction } from '@ffc/core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_DAILY_QUOTA_SETTING_KEY } from '../src/modules/ai/ai-settings.service';
import { adminLogin, makeAdminWithMfa } from './auth-helpers';
import {
  type AiTestContext,
  createAiTestApp,
  createIdentification,
  customer,
  getIdentification,
  makeExe,
  makeJpeg,
  makeOversized,
  runFullFlow,
  submitIdentification,
  uploadPhoto,
} from './ai-helpers';

/**
 * Pipeline de vision IA (tâche 17) — critères d'acceptation :
 *   1. mode B (driver log) : dimensions + MERV extraits → variante exacte
 *      proposée → COMPLETED ; sous le seuil → NEEDS_REVIEW et tuile
 *      aiReviewQueue incrémentée ;
 *   2. sécurité du téléversement : exécutable renommé .jpg rejeté (contenu),
 *      11 Mo rejeté, EXIF GPS absent de l'objet final, identification d'un
 *      autre compte invisible (404) ;
 *   3. quota : la (quota+1)ᵉ requête du jour → 429 ; le lendemain, ça repasse ;
 *   4. job rejoué → un seul appel fournisseur, un seul résultat ;
 *   5. purge à 31 jours : objet S3 supprimé, extraction effacée, purgedAt
 *      posé ; relance sans effet (idempotence) ;
 *   6. sans clé API (driver anthropic) → 503 propre.
 */
describe('Pipeline de vision IA (tâche 17)', () => {
  let ctx: AiTestContext;

  beforeAll(async () => {
    ctx = await createAiTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Extraction de base — surcharge par cas de test. */
  function extraction(partial: Partial<VisionExtraction>): VisionExtraction {
    return {
      manufacturer: { value: null, confidence: 0 },
      modelNumber: { value: null, confidence: 0 },
      dimensions: { widthIn: null, heightIn: null, depthIn: null, confidence: 0 },
      merv: { value: null, confidence: 0 },
      readableText: null,
      suggestedMode: null,
      overallConfidence: 0.9,
      notes: null,
      ...partial,
    };
  }

  async function dashboardAiReviewQueue(): Promise<number> {
    const admin = await makeAdminWithMfa(ctx, ['lecture_seule']);
    const token = await adminLogin(ctx, admin.email, admin.password, admin.recoveryCodes[0]!);
    const response = await ctx
      .http()
      .get('/v1/admin/dashboard/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body.aiReviewQueue as number;
  }

  /* ---------------- CRITÈRE 1 : mode B → COMPLETED / NEEDS_REVIEW -------- */

  it('mode B : dimensions + MERV extraits → variantes exactes proposées → COMPLETED', async () => {
    const { authorization } = await customer(ctx);
    // Fixture par défaut du driver log : 16x25x1, MERV 11, confiance 0,93.
    const { body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');

    expect(body.status).toBe('COMPLETED');
    expect(body.confidence).toBeCloseTo(0.93, 2);
    const result = body.result as {
      dimensions: { label: string | null };
      merv: { value: number | null };
    };
    expect(result.dimensions.label).toBe('16x25x1');
    expect(result.merv.value).toBe(11);

    const variants = body.suggestedVariants as Array<Record<string, unknown>>;
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) expect(variant.nominalLabel).toBe('16x25x1');
    // La cote MERV extraite (11) place les variantes MERV 11 en tête.
    expect(variants[0]!.merv).toBe(11);
    expect(variants[0]!.mervMatches).toBe(true);
  });

  it('mode B : dimensions réelles (15,75 × 24,75 × 0,75) → mêmes variantes nominales 16x25x1', async () => {
    const { authorization } = await customer(ctx);
    ctx.vision.stage(
      extraction({
        dimensions: { widthIn: 15.75, heightIn: 24.75, depthIn: 0.75, confidence: 0.9 },
        merv: { value: 11, confidence: 0.9 },
        overallConfidence: 0.91,
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');
    expect(body.status).toBe('COMPLETED');
    const variants = body.suggestedVariants as Array<Record<string, unknown>>;
    expect(variants.length).toBeGreaterThan(0);
    expect(variants[0]!.nominalLabel).toBe('16x25x1');
  });

  it('extraction sous le seuil → NEEDS_REVIEW et tuile aiReviewQueue incrémentée', async () => {
    const before = await dashboardAiReviewQueue();

    const { authorization } = await customer(ctx);
    ctx.vision.stage(
      extraction({
        dimensions: { widthIn: 16, heightIn: 25, depthIn: 1, confidence: 0.4 },
        merv: { value: 11, confidence: 0.3 },
        overallConfidence: 0.42, // sous le seuil 0,85
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');

    expect(body.status).toBe('NEEDS_REVIEW');
    // Les variantes restent proposées : la révision humaine (tâche 18) tranche.
    expect((body.suggestedVariants as unknown[]).length).toBeGreaterThan(0);

    expect(await dashboardAiReviewQueue()).toBe(before + 1);
  });

  it('extraction confiante mais SANS correspondance → NEEDS_REVIEW', async () => {
    const { authorization } = await customer(ctx);
    ctx.vision.stage(
      extraction({
        readableText: 'Étiquette illisible, aucune dimension imprimée',
        overallConfidence: 0.95, // au-dessus du seuil, mais rien à proposer
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');
    expect(body.status).toBe('NEEDS_REVIEW');
    expect(body.suggestedVariants).toEqual([]);
  });

  /* --------------------- Mode A : correspondances ------------------------ */

  it('mode A : alias exact (fixture Lennox G61MPV-36B-070) → COMPLETED + variantes compatibles', async () => {
    const { authorization } = await customer(ctx);
    const { body } = await runFullFlow(ctx, authorization, 'EQUIPMENT_LABEL');

    expect(body.status).toBe('COMPLETED');
    const matched = body.matchedEquipmentModel as Record<string, unknown>;
    expect(matched.manufacturer).toBe('Lennox');
    expect(matched.modelNumber).toBe('G61MPV');
    expect((body.match as Record<string, unknown>).kind).toBe('alias');

    // Compatibilités du seed : cabinet média 16x25x5 (boîtes de 1).
    const variants = body.suggestedVariants as Array<Record<string, unknown>>;
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) expect(variant.nominalLabel).toBe('16x25x5');
  });

  it('mode A : numéro déjà résolu (alias, graphie différente) → jamais en révision, même sous le seuil', async () => {
    const { authorization } = await customer(ctx);
    ctx.vision.stage(
      extraction({
        manufacturer: { value: 'Lennox Industries', confidence: 0.4 },
        modelNumber: { value: 'g61mpv 36b 070', confidence: 0.35 },
        overallConfidence: 0.3, // très en dessous du seuil…
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'EQUIPMENT_LABEL');

    // …mais le cache de correspondance (equipment_models + alias) court-circuite la révision.
    expect(body.status).toBe('COMPLETED');
    expect((body.match as Record<string, unknown>).kind).toBe('alias');
    expect((body.matchedEquipmentModel as Record<string, unknown>).modelNumber).toBe('G61MPV');
  });

  it('mode A : numéro exact (Carrier 59SC5) → correspondance exacte', async () => {
    const { authorization } = await customer(ctx);
    ctx.vision.stage(
      extraction({
        manufacturer: { value: 'Carrier', confidence: 0.9 },
        modelNumber: { value: '59sc5', confidence: 0.92 },
        overallConfidence: 0.9,
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'EQUIPMENT_LABEL');
    expect(body.status).toBe('COMPLETED');
    expect((body.match as Record<string, unknown>).kind).toBe('exact');
    expect((body.matchedEquipmentModel as Record<string, unknown>).modelNumber).toBe('59SC5');
  });

  it('mode A : faute de frappe (flou sous le seuil d’acceptation) → candidates proposées, NEEDS_REVIEW', async () => {
    const { authorization } = await customer(ctx);
    // « BM » au lieu de « BN » : proche de l'alias GMVC960603BN sans l'égaler.
    ctx.vision.stage(
      extraction({
        manufacturer: { value: 'Goodman', confidence: 0.9 },
        modelNumber: { value: 'GMVC960603BM', confidence: 0.9 },
        overallConfidence: 0.9,
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'EQUIPMENT_LABEL');
    expect(body.status).toBe('NEEDS_REVIEW');
    expect(body.matchedEquipmentModel).toBeNull();
    const match = body.match as { candidates: Array<Record<string, unknown>> };
    expect(match.candidates.length).toBeGreaterThan(0);
    expect(match.candidates[0]!.modelNumber).toBe('GMVC96');
  });

  it('signale le mode suggéré quand la photo ressemble à l’autre mode', async () => {
    const { authorization } = await customer(ctx);
    ctx.vision.stage(
      extraction({
        suggestedMode: 'EQUIPMENT_LABEL',
        readableText: 'MODEL NO … SERIAL NO …',
        overallConfidence: 0.5,
      }),
    );
    const { body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');
    expect(body.status).toBe('NEEDS_REVIEW');
    expect((body.result as Record<string, unknown>).suggestedMode).toBe('EQUIPMENT_LABEL');
  });

  it('échec définitif du fournisseur → FAILED avec failureReason', async () => {
    const { authorization } = await customer(ctx);
    ctx.vision.stageError('Sortie structurée invalide : gribouillis.', false);
    const { body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');
    expect(body.status).toBe('FAILED');
    expect(body.failureReason).toContain('Sortie structurée invalide');
  });

  /* ------------------- CRITÈRE 2 : sécurité du téléversement ------------- */

  it('rejette un exécutable renommé .jpg sur son CONTENU (octets magiques)', async () => {
    const { authorization } = await customer(ctx);
    const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');
    await uploadPhoto(ctx, created.key, makeExe());

    const body = await submitIdentification(ctx, authorization, created.id, 400);
    expect(String(body.message)).toContain('pas une image acceptée');

    const after = await getIdentification(ctx, authorization, created.id);
    expect(after.status).toBe('PENDING'); // rien n'est parti en analyse
  });

  it('rejette une photo de 11 Mo (au-delà de la politique de 10 Mo)', async () => {
    const { authorization } = await customer(ctx);
    const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');
    // Écriture directe (simule un contournement de la politique S3) : la
    // défense en profondeur de l'API doit quand même refuser.
    await uploadPhoto(ctx, created.key, makeOversized());

    const body = await submitIdentification(ctx, authorization, created.id, 400);
    expect(String(body.message)).toContain('10 Mo');
  });

  it('retire l’EXIF (GPS) de l’objet final — vérifié sur les octets stockés', async () => {
    const { authorization } = await customer(ctx);
    const photo = await makeJpeg({ gps: true });
    // Le cliché d'origine contient bien un bloc EXIF (sinon le test ne prouve rien).
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');
    await uploadPhoto(ctx, created.key, photo);
    await submitIdentification(ctx, authorization, created.id);

    const stored = await ctx.storage.fetch(created.key);
    expect(stored).not.toBeNull();
    const metadata = await sharp(stored!).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined(); // plus aucune métadonnée, GPS compris
  });

  it('accepte PNG et WebP par leur contenu (ré-encodés en JPEG)', async () => {
    const { authorization } = await customer(ctx);
    for (const format of ['png', 'webp'] as const) {
      const image = await sharp({
        create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 80, b: 160 } },
      })
        [format]()
        .toBuffer();
      const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');
      await uploadPhoto(ctx, created.key, image);
      const body = await submitIdentification(ctx, authorization, created.id);
      expect(body.status).toBe('COMPLETED');
      const stored = await ctx.storage.fetch(created.key);
      expect((await sharp(stored!).metadata()).format).toBe('jpeg');
    }
  });

  it('un utilisateur ne peut ni lire ni soumettre l’identification d’un autre (404)', async () => {
    const alice = await customer(ctx);
    const bob = await customer(ctx);
    const { id } = await runFullFlow(ctx, alice.authorization, 'FILTER_FRAME');

    await getIdentification(ctx, bob.authorization, id, 404);
    await submitIdentification(ctx, bob.authorization, id, 404);
    // La propriétaire, elle, voit toujours son résultat.
    const body = await getIdentification(ctx, alice.authorization, id);
    expect(body.status).toBe('COMPLETED');
  });

  it('refuse la création sans consentement explicite (400) et trace le consentement donné', async () => {
    const { authorization, userId } = await customer(ctx);

    for (const consent of [false, undefined]) {
      const response = await ctx
        .http()
        .post('/v1/ai/identifications')
        .set('Authorization', authorization)
        .send({ mode: 'FILTER_FRAME', ...(consent === undefined ? {} : { consent }) })
        .expect(400);
      expect(JSON.stringify(response.body.message)).toContain('consentement');
    }

    const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'ai.identification.creation', entityId: created.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(userId);
    expect((audit!.metadata as Record<string, unknown>).consent).toBe(true);
    expect((audit!.metadata as Record<string, unknown>).mode).toBe('FILTER_FRAME');
  });

  it('soumission sans téléversement → 400 ; double soumission → 409', async () => {
    const { authorization } = await customer(ctx);
    const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');

    const body = await submitIdentification(ctx, authorization, created.id, 400);
    expect(String(body.message)).toContain('Téléversez');

    await uploadPhoto(ctx, created.key, await makeJpeg());
    await submitIdentification(ctx, authorization, created.id, 200);
    await submitIdentification(ctx, authorization, created.id, 409);
  });

  /* --------------------------- CRITÈRE 3 : quota -------------------------- */

  it('la (quota+1)ᵉ requête du jour → 429 ; le lendemain, ça repasse', async () => {
    await ctx.prisma.setting.upsert({
      where: { key: AI_DAILY_QUOTA_SETTING_KEY },
      update: { value: 2 },
      create: { key: AI_DAILY_QUOTA_SETTING_KEY, value: 2 },
    });
    try {
      const { authorization, userId } = await customer(ctx);
      await createIdentification(ctx, authorization, 'FILTER_FRAME');
      await createIdentification(ctx, authorization, 'EQUIPMENT_LABEL');

      const refused = await ctx
        .http()
        .post('/v1/ai/identifications')
        .set('Authorization', authorization)
        .send({ mode: 'FILTER_FRAME', consent: true })
        .expect(429);
      expect(String(refused.body.message)).toContain('Limite quotidienne atteinte (2');

      // Le lendemain : les créations d'hier ne comptent plus.
      const yesterday = new Date(Date.now() - 24 * 3_600_000);
      await ctx.prisma.aiIdentification.updateMany({
        where: { userId },
        data: { createdAt: yesterday },
      });
      await createIdentification(ctx, authorization, 'FILTER_FRAME');
    } finally {
      await ctx.prisma.setting.update({
        where: { key: AI_DAILY_QUOTA_SETTING_KEY },
        data: { value: 10 },
      });
    }
  });

  /* ------------------- CRITÈRE 4 : job rejoué (idempotence) --------------- */

  it('job de vision rejoué → un seul appel fournisseur, un seul résultat', async () => {
    const { authorization } = await customer(ctx);
    const { id, body } = await runFullFlow(ctx, authorization, 'FILTER_FRAME');
    expect(body.status).toBe('COMPLETED');

    const callsAfterFirstRun = ctx.vision.calls;
    const rowBefore = await ctx.prisma.aiIdentification.findUniqueOrThrow({ where: { id } });

    // Rejeu BullMQ simulé : même identification, nouveau passage du worker.
    const outcome = await ctx.processor.process(id, { finalAttempt: true });

    expect(outcome).toBe('skipped');
    expect(ctx.vision.calls).toBe(callsAfterFirstRun); // JAMAIS de double facturation
    const rowAfter = await ctx.prisma.aiIdentification.findUniqueOrThrow({ where: { id } });
    expect(rowAfter.status).toBe('COMPLETED');
    expect(rowAfter.updatedAt.getTime()).toBe(rowBefore.updatedAt.getTime());
  });

  /* ------------------------- CRITÈRE 5 : purge 30 j ----------------------- */

  it('purge à 31 jours : objet supprimé, extraction effacée, purgedAt posé — relance sans effet', async () => {
    const { authorization } = await customer(ctx);
    const created = await createIdentification(ctx, authorization, 'FILTER_FRAME');
    await uploadPhoto(ctx, created.key, await makeJpeg());
    await submitIdentification(ctx, authorization, created.id);

    // Identification datée de 31 jours (purgeAt échu).
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 3_600_000);
    await ctx.prisma.aiIdentification.update({
      where: { id: created.id },
      data: { createdAt: thirtyOneDaysAgo, purgeAt: new Date(Date.now() - 24 * 3_600_000) },
    });

    const first = await ctx.purge.purgeDue();
    expect(first.purged).toBeGreaterThanOrEqual(1);

    expect(await ctx.storage.fetch(created.key)).toBeNull(); // objet S3 supprimé
    const row = await ctx.prisma.aiIdentification.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.purgedAt).not.toBeNull();
    const marker = row.extraction as Record<string, unknown>;
    expect(marker.vision).toBeUndefined(); // extraction effacée…
    expect(marker.purge).toBeDefined(); // …remplacée par le marqueur minimal
    expect(marker.mode).toBe('FILTER_FRAME');
    expect(parseAiExtractionEnvelope(row.extraction)?.vision).toBeUndefined();

    // L'API du propriétaire reflète la purge sans exposer de résultat.
    const body = await getIdentification(ctx, authorization, created.id);
    expect(body.purgedAt).not.toBeNull();
    expect(body.result).toBeNull();

    // Relance : plus rien à purger, la ligne n'est pas retouchée (idempotent).
    const purgedAtFirst = row.purgedAt!.getTime();
    const second = await ctx.purge.purgeDue();
    expect(second.purged).toBe(0);
    const rowAfter = await ctx.prisma.aiIdentification.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(rowAfter.purgedAt!.getTime()).toBe(purgedAtFirst);
  });
});

/* ------------------- CRITÈRE 6 : 503 sans clé API ------------------------ */

describe('Pipeline de vision IA — fournisseur non configuré (503)', () => {
  let ctx: AiTestContext;

  beforeAll(async () => {
    // Fournisseur Anthropic RÉEL mais sans clé : les endpoints répondent 503.
    ctx = await createAiTestApp({ unconfiguredProvider: true });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('répond 503 avec un message clair quand la clé API est absente', async () => {
    const { authorization } = await customer(ctx);
    const response = await ctx
      .http()
      .post('/v1/ai/identifications')
      .set('Authorization', authorization)
      .send({ mode: 'FILTER_FRAME', consent: true })
      .expect(503);
    expect(String(response.body.message)).toContain('fournisseur de vision');
  });
});
