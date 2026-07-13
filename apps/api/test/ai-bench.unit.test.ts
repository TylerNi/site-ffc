import { type VisionExtraction } from '@ffc/core';
import { describe, expect, it } from 'vitest';
import {
  aggregateResults,
  type BenchCaseResult,
  parseTruthCsv,
  recommendProvider,
  renderBenchReport,
  scoreExtraction,
} from '../src/modules/ai/bench/bench';
import { callCostUsd, pricingForModel } from '../src/modules/ai/bench/vision-pricing';

/**
 * Banc d'essai Claude vs GPT (tâche 17) — logique pure exercée sur des
 * FIXTURES ANONYMISÉES (aucun réseau, aucune vraie photo) : CSV de vérité,
 * comparaison champ par champ, agrégats, coût réel (jetons × tarifs),
 * recommandation et rendu du rapport.
 */

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

describe('Banc d’essai — CSV de vérité', () => {
  it('lit l’en-tête français, les raccourcis A/B et les champs vides', () => {
    const truths = parseTruthCsv(
      [
        'fichier,mode,fabricant,numero_modele,largeur,hauteur,profondeur,merv',
        'photo-001.jpg,EQUIPMENT_LABEL,Fabricant Anonyme,MOD-123-XYZ,,,,',
        'photo-002.jpg,B,,,16,25,1,11',
        '"photo, virgule.jpg",A,"Marque, inc.",M2,,,,',
        '# commentaire ignoré',
      ].join('\n'),
    );
    expect(truths).toHaveLength(3);
    expect(truths[0]!.mode).toBe('EQUIPMENT_LABEL');
    expect(truths[0]!.modelNumber).toBe('MOD-123-XYZ');
    expect(truths[0]!.widthIn).toBeNull();
    expect(truths[1]!.mode).toBe('FILTER_FRAME');
    expect(truths[1]!.merv).toBe(11);
    expect(truths[2]!.file).toBe('photo, virgule.jpg');
    expect(truths[2]!.manufacturer).toBe('Marque, inc.');
  });

  it('refuse un CSV sans colonnes obligatoires ou au mode invalide', () => {
    expect(() => parseTruthCsv('nom,type\nx,y')).toThrow(/fichier/);
    expect(() => parseTruthCsv('fichier,mode\nphoto.jpg,PORTRAIT')).toThrow(/mode invalide/);
  });
});

describe('Banc d’essai — comparaison champ par champ', () => {
  const truth = {
    file: 'photo-002.jpg',
    mode: 'FILTER_FRAME' as const,
    manufacturer: null,
    modelNumber: null,
    widthIn: 16,
    heightIn: 25,
    depthIn: 1,
    merv: 11,
  };

  it('dimensions : nominal exact, taille réelle et orientation inversée acceptés', () => {
    const nominal = scoreExtraction(
      truth,
      extraction({ dimensions: { widthIn: 16, heightIn: 25, depthIn: 1, confidence: 0.9 } }),
    );
    expect(nominal.dimensions).toBe(true);

    const actual = scoreExtraction(
      truth,
      extraction({
        dimensions: { widthIn: 15.75, heightIn: 24.75, depthIn: 0.75, confidence: 0.9 },
      }),
    );
    expect(actual.dimensions).toBe(true);

    const swapped = scoreExtraction(
      truth,
      extraction({ dimensions: { widthIn: 25, heightIn: 16, depthIn: 1, confidence: 0.9 } }),
    );
    expect(swapped.dimensions).toBe(true);

    const wrong = scoreExtraction(
      truth,
      extraction({ dimensions: { widthIn: 20, heightIn: 25, depthIn: 1, confidence: 0.9 } }),
    );
    expect(wrong.dimensions).toBe(false);
  });

  it('numéro de modèle normalisé ; MERV exact ; champs sans vérité non évalués (null)', () => {
    const labelTruth = { ...truth, mode: 'EQUIPMENT_LABEL' as const, modelNumber: 'MOD-123-XYZ' };
    const scores = scoreExtraction(
      labelTruth,
      extraction({
        modelNumber: { value: 'mod 123 xyz', confidence: 0.8 },
        dimensions: { widthIn: 16, heightIn: 25, depthIn: 1, confidence: 0.9 },
        merv: { value: 8, confidence: 0.9 },
      }),
    );
    expect(scores.modelNumber).toBe(true);
    expect(scores.manufacturer).toBeNull(); // pas de vérité fabricant
    expect(scores.merv).toBe(false); // 8 ≠ 11
  });
});

describe('Banc d’essai — coûts, agrégats et recommandation', () => {
  it('coût réel = jetons × tarifs ; modèle inconnu → null (jamais inventé)', () => {
    expect(pricingForModel('claude-opus-4-8')).not.toBeNull();
    expect(pricingForModel('gpt-5.1-2025-11-13')).not.toBeNull(); // préfixe daté
    expect(pricingForModel('modele-mystere-9000')).toBeNull();

    // claude-opus-4-8 : 5 $/M entrée, 25 $/M sortie.
    const cost = callCostUsd('claude-opus-4-8', { inputTokens: 2_000, outputTokens: 400 });
    expect(cost).toBeCloseTo((2_000 * 5 + 400 * 25) / 1_000_000, 6);
    expect(callCostUsd('claude-opus-4-8', null)).toBeNull();
  });

  function caseResult(partial: Partial<BenchCaseResult>): BenchCaseResult {
    return {
      file: 'photo.jpg',
      mode: 'FILTER_FRAME',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      ok: true,
      error: null,
      latencyMs: 1_000,
      usage: { inputTokens: 2_000, outputTokens: 400 },
      costUsd: 0.02,
      fields: { manufacturer: null, modelNumber: null, dimensions: true, merv: true },
      matched: true,
      ...partial,
    };
  }

  it('agrège précision par champ et par mode, latence, jetons et coût moyen', () => {
    const results: BenchCaseResult[] = [
      caseResult({ file: 'a.jpg', latencyMs: 800 }),
      caseResult({
        file: 'b.jpg',
        latencyMs: 1_200,
        fields: { manufacturer: null, modelNumber: null, dimensions: false, merv: true },
        matched: false,
      }),
      caseResult({
        file: 'c.jpg',
        mode: 'EQUIPMENT_LABEL',
        fields: { manufacturer: true, modelNumber: true, dimensions: null, merv: null },
      }),
      caseResult({
        file: 'd.jpg',
        ok: false,
        error: 'panne',
        usage: null,
        costUsd: null,
        latencyMs: 0,
        fields: { manufacturer: null, modelNumber: null, dimensions: null, merv: null },
        matched: null,
      }),
    ];

    const [aggregate] = aggregateResults(results);
    expect(aggregate!.cases).toBe(4);
    expect(aggregate!.okCases).toBe(3);

    const frame = aggregate!.byMode.FILTER_FRAME!;
    expect(frame.fields.dimensions).toEqual({ correct: 1, evaluated: 2 });
    expect(frame.fields.merv).toEqual({ correct: 2, evaluated: 2 });
    expect(frame.matchRate).toEqual({ correct: 1, evaluated: 2 });

    const label = aggregate!.byMode.EQUIPMENT_LABEL!;
    expect(label.fields.modelNumber).toEqual({ correct: 1, evaluated: 1 });

    expect(aggregate!.latency.avgMs).toBe(1_000);
    expect(aggregate!.tokens.input).toBe(6_000);
    expect(aggregate!.cost.avgPerPhotoUsd).toBeCloseTo(0.02, 6);
    // 6 champs évalués, 5 corrects.
    expect(aggregate!.overallFieldAccuracy).toBeCloseTo(5 / 6, 6);
  });

  it('recommande la meilleure précision ; à égalité, le coût départage', () => {
    const anthropic = aggregateResults([
      caseResult({
        provider: 'anthropic',
        fields: { manufacturer: null, modelNumber: null, dimensions: true, merv: true },
      }),
    ])[0]!;
    const openai = aggregateResults([
      caseResult({
        provider: 'openai',
        model: 'gpt-5.1',
        fields: { manufacturer: null, modelNumber: null, dimensions: false, merv: false },
        costUsd: 0.005,
      }),
    ])[0]!;

    const byAccuracy = recommendProvider([anthropic, openai]);
    expect(byAccuracy.provider).toBe('anthropic');
    expect(byAccuracy.reasons.join(' ')).toContain('Précision globale');

    // Précisions identiques → le moins cher gagne.
    const cheap = aggregateResults([
      caseResult({ provider: 'openai', model: 'gpt-5.1', costUsd: 0.005 }),
    ])[0]!;
    const byCost = recommendProvider([anthropic, cheap]);
    expect(byCost.provider).toBe('openai');
    expect(byCost.reasons.join(' ')).toContain('Coût moyen par photo');
  });

  it('un seul fournisseur exécuté → recommandé par défaut, avec réserve', () => {
    const only = aggregateResults([caseResult({})])[0]!;
    const recommendation = recommendProvider([only]);
    expect(recommendation.provider).toBe('anthropic');
    expect(recommendation.reasons[0]).toContain('Seul fournisseur');
  });

  it('rend le rapport complet : précision, correspondance, latence, coût, recommandation', () => {
    const results = [
      caseResult({ file: 'anonyme-01.jpg' }),
      caseResult({
        file: 'anonyme-02.jpg',
        provider: 'openai',
        model: 'gpt-5.1',
        costUsd: 0.004,
        fields: { manufacturer: null, modelNumber: null, dimensions: true, merv: false },
      }),
      caseResult({
        file: 'anonyme-03.jpg',
        ok: false,
        error: 'clé expirée',
        usage: null,
        costUsd: null,
      }),
    ];
    const report = renderBenchReport(results, aggregateResults(results), {
      photosDir: 'D:/photos-bench',
      truthCsv: 'D:/photos-bench/verite.csv',
      generatedAt: new Date('2026-07-12T12:00:00Z'),
      matchingEvaluated: true,
    });

    expect(report).toContain('# Banc d’essai vision IA — Claude vs GPT');
    expect(report).toContain('anthropic — `claude-opus-4-8`');
    expect(report).toContain('openai — `gpt-5.1`');
    expect(report).toContain(
      '| Mode | Cas | Fabricant | Numéro de modèle | Dimensions | MERV | Correspondance |',
    );
    expect(report).toContain('Coût réel');
    expect(report).toContain('## Analyses en échec');
    expect(report).toContain('clé expirée');
    expect(report).toContain('## Recommandation');
    expect(report).toContain('## Détail des cas');
  });
});
