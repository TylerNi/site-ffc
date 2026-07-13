import {
  type AiAnalysisMode,
  aiAnalysisModeSchema,
  canonicalDimensionLabel,
  dimensionEquivalents,
  type VisionExtraction,
} from '@ffc/core';
import { normalizeManufacturer, normalizeModelNumber } from '../ai-matching.service';
import { callCostUsd } from './vision-pricing';

/**
 * Banc d'essai comparatif Claude vs GPT (tâche 17) — LOGIQUE PURE, sans
 * réseau ni base : lecture du CSV de vérité, comparaison champ par champ,
 * agrégats et rendu du rapport `docs/ia-banc-essai.md`. Le script
 * `scripts/ai-bench.ts` orchestre les appels réels ; les tests automatisés
 * exercent ces fonctions sur des fixtures anonymisées.
 */

export interface BenchTruth {
  file: string;
  mode: AiAnalysisMode;
  manufacturer: string | null;
  modelNumber: string | null;
  widthIn: number | null;
  heightIn: number | null;
  depthIn: number | null;
  merv: number | null;
}

/** Champs évalués : true/false = correct/incorrect ; null = pas de vérité attendue. */
export interface BenchFieldScores {
  manufacturer: boolean | null;
  modelNumber: boolean | null;
  dimensions: boolean | null;
  merv: boolean | null;
}

export interface BenchCaseResult {
  file: string;
  mode: AiAnalysisMode;
  provider: string;
  model: string;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
  fields: BenchFieldScores;
  /** Correspondance trouvée en base (null = non évaluée — BD absente). */
  matched: boolean | null;
}

/* ------------------------------- CSV ---------------------------------- */

const CSV_COLUMNS = [
  'fichier',
  'mode',
  'fabricant',
  'numero_modele',
  'largeur',
  'hauteur',
  'profondeur',
  'merv',
] as const;

/**
 * Lit le CSV de vérité terrain. Colonnes attendues (en-tête obligatoire) :
 * `fichier,mode,fabricant,numero_modele,largeur,hauteur,profondeur,merv` —
 * mode accepté : EQUIPMENT_LABEL/FILTER_FRAME (ou raccourcis A/B). Champs
 * vides = non attendus (non évalués).
 */
export function parseTruthCsv(content: string): BenchTruth[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) throw new Error('CSV de vérité vide.');

  const header = splitCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const indexOf = (column: (typeof CSV_COLUMNS)[number]): number => header.indexOf(column);
  for (const required of ['fichier', 'mode'] as const) {
    if (indexOf(required) === -1) {
      throw new Error(
        `Colonne « ${required} » absente de l'en-tête CSV. Colonnes attendues : ${CSV_COLUMNS.join(', ')}.`,
      );
    }
  }

  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
    const cell = (column: (typeof CSV_COLUMNS)[number]): string | null => {
      const index = indexOf(column);
      const value = index === -1 ? '' : (cells[index] ?? '').trim();
      return value === '' ? null : value;
    };

    const file = cell('fichier');
    if (!file) throw new Error(`Ligne ${i + 2} : fichier manquant.`);
    const mode = parseMode(cell('mode'));
    if (!mode)
      throw new Error(`Ligne ${i + 2} : mode invalide (EQUIPMENT_LABEL/FILTER_FRAME ou A/B).`);

    return {
      file,
      mode,
      manufacturer: cell('fabricant'),
      modelNumber: cell('numero_modele'),
      widthIn: parseNumber(cell('largeur')),
      heightIn: parseNumber(cell('hauteur')),
      depthIn: parseNumber(cell('profondeur')),
      merv: parseNumber(cell('merv')),
    };
  });
}

/** Découpe une ligne CSV en respectant les guillemets doubles. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseMode(raw: string | null): AiAnalysisMode | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'A') return 'EQUIPMENT_LABEL';
  if (upper === 'B') return 'FILTER_FRAME';
  const parsed = aiAnalysisModeSchema.safeParse(upper);
  return parsed.success ? parsed.data : null;
}

function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/* ---------------------------- Comparaison ------------------------------ */

/** Tolérance numérique quand une taille est hors référentiel (réel vs nominal). */
const DIMENSION_TOLERANCE_IN = 0.5;

/** Compare l'extraction à la vérité terrain, champ par champ. */
export function scoreExtraction(truth: BenchTruth, extraction: VisionExtraction): BenchFieldScores {
  return {
    manufacturer:
      truth.manufacturer === null
        ? null
        : manufacturersEqual(truth.manufacturer, extraction.manufacturer.value),
    modelNumber:
      truth.modelNumber === null
        ? null
        : extraction.modelNumber.value !== null &&
          normalizeModelNumber(extraction.modelNumber.value) ===
            normalizeModelNumber(truth.modelNumber),
    dimensions:
      truth.widthIn === null || truth.heightIn === null ? null : dimensionsEqual(truth, extraction),
    merv: truth.merv === null ? null : extraction.merv.value === truth.merv,
  };
}

function manufacturersEqual(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = normalizeManufacturer(expected);
  const b = normalizeManufacturer(actual);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/**
 * Les dimensions concordent si les libellés canoniques se résolvent aux
 * mêmes tailles du référentiel (nominal ↔ réel, orientation indifférente) ;
 * hors référentiel, comparaison numérique tolérante avec orientation
 * interchangeable.
 */
function dimensionsEqual(truth: BenchTruth, extraction: VisionExtraction): boolean {
  const { widthIn, heightIn, depthIn } = extraction.dimensions;
  if (widthIn === null || heightIn === null) return false;

  const truthLabel = canonicalDimensionLabel({
    width: truth.widthIn!,
    height: truth.heightIn!,
    depth: truth.depthIn,
  });
  const extractedLabel = canonicalDimensionLabel({
    width: widthIn,
    height: heightIn,
    depth: depthIn,
  });
  const truthSizes = dimensionEquivalents(truthLabel)?.labels ?? [];
  const extractedSizes = dimensionEquivalents(extractedLabel)?.labels ?? [];
  if (truthSizes.length > 0 && extractedSizes.some((label) => truthSizes.includes(label))) {
    return true;
  }

  const near = (a: number, b: number): boolean => Math.abs(a - b) <= DIMENSION_TOLERANCE_IN;
  const faces =
    (near(widthIn, truth.widthIn!) && near(heightIn, truth.heightIn!)) ||
    (near(widthIn, truth.heightIn!) && near(heightIn, truth.widthIn!));
  const depth = truth.depthIn === null || (depthIn !== null && near(depthIn, truth.depthIn));
  return faces && depth;
}

/* ----------------------------- Agrégats -------------------------------- */

export interface BenchFieldAggregate {
  correct: number;
  evaluated: number;
}

export interface BenchModeAggregate {
  cases: number;
  okCases: number;
  fields: Record<keyof BenchFieldScores, BenchFieldAggregate>;
  matchRate: BenchFieldAggregate;
}

export interface BenchProviderAggregate {
  provider: string;
  model: string;
  cases: number;
  okCases: number;
  byMode: Partial<Record<AiAnalysisMode, BenchModeAggregate>>;
  latency: { avgMs: number; p50Ms: number; maxMs: number };
  tokens: { input: number; output: number };
  cost: { totalUsd: number | null; avgPerPhotoUsd: number | null; pricedCases: number };
  /** Précision globale (tous champs évalués confondus) — base de la recommandation. */
  overallFieldAccuracy: number | null;
}

export function aggregateResults(results: BenchCaseResult[]): BenchProviderAggregate[] {
  const providers = [...new Set(results.map((result) => result.provider))];
  return providers.map((provider) => {
    const mine = results.filter((result) => result.provider === provider);
    const okResults = mine.filter((result) => result.ok);

    const byMode: Partial<Record<AiAnalysisMode, BenchModeAggregate>> = {};
    for (const result of mine) {
      const modeAggregate = (byMode[result.mode] ??= emptyModeAggregate());
      modeAggregate.cases += 1;
      if (result.ok) modeAggregate.okCases += 1;
      for (const key of Object.keys(result.fields) as (keyof BenchFieldScores)[]) {
        const score = result.fields[key];
        if (score === null) continue;
        modeAggregate.fields[key].evaluated += 1;
        if (score) modeAggregate.fields[key].correct += 1;
      }
      if (result.matched !== null) {
        modeAggregate.matchRate.evaluated += 1;
        if (result.matched) modeAggregate.matchRate.correct += 1;
      }
    }

    const latencies = okResults.map((result) => result.latencyMs).sort((a, b) => a - b);
    const priced = okResults.filter((result) => result.costUsd !== null);
    const totalUsd = priced.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);

    let fieldCorrect = 0;
    let fieldEvaluated = 0;
    for (const mode of Object.values(byMode)) {
      for (const aggregate of Object.values(mode.fields)) {
        fieldCorrect += aggregate.correct;
        fieldEvaluated += aggregate.evaluated;
      }
    }

    return {
      provider,
      model: mine[0]?.model ?? '?',
      cases: mine.length,
      okCases: okResults.length,
      byMode,
      latency: {
        avgMs: latencies.length
          ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
          : 0,
        p50Ms: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)]! : 0,
        maxMs: latencies.length ? latencies[latencies.length - 1]! : 0,
      },
      tokens: {
        input: okResults.reduce((sum, result) => sum + (result.usage?.inputTokens ?? 0), 0),
        output: okResults.reduce((sum, result) => sum + (result.usage?.outputTokens ?? 0), 0),
      },
      cost: {
        totalUsd: priced.length ? round4(totalUsd) : null,
        avgPerPhotoUsd: priced.length ? round4(totalUsd / priced.length) : null,
        pricedCases: priced.length,
      },
      overallFieldAccuracy: fieldEvaluated ? fieldCorrect / fieldEvaluated : null,
    };
  });
}

function emptyModeAggregate(): BenchModeAggregate {
  return {
    cases: 0,
    okCases: 0,
    fields: {
      manufacturer: { correct: 0, evaluated: 0 },
      modelNumber: { correct: 0, evaluated: 0 },
      dimensions: { correct: 0, evaluated: 0 },
      merv: { correct: 0, evaluated: 0 },
    },
    matchRate: { correct: 0, evaluated: 0 },
  };
}

/* --------------------------- Recommandation ---------------------------- */

export interface BenchRecommendation {
  provider: string | null;
  reasons: string[];
}

/**
 * Recommandation motivée : précision d'abord (écart significatif > 3 points),
 * puis coût par photo, puis latence. Un seul fournisseur exécuté →
 * recommandé par défaut, avec réserve.
 */
export function recommendProvider(aggregates: BenchProviderAggregate[]): BenchRecommendation {
  const ranked = aggregates.filter((aggregate) => aggregate.okCases > 0);
  if (ranked.length === 0) return { provider: null, reasons: ['Aucune analyse aboutie.'] };
  if (ranked.length === 1) {
    return {
      provider: ranked[0]!.provider,
      reasons: [
        `Seul fournisseur exécuté (${ranked[0]!.model}) — comparer dès que la clé de l'autre fournisseur sera disponible.`,
      ],
    };
  }

  const [a, b] = [ranked[0]!, ranked[1]!];
  const reasons: string[] = [];
  const accuracyA = a.overallFieldAccuracy ?? 0;
  const accuracyB = b.overallFieldAccuracy ?? 0;
  const accuracyGap = accuracyA - accuracyB;

  if (Math.abs(accuracyGap) > 0.03) {
    const winner = accuracyGap > 0 ? a : b;
    const loser = accuracyGap > 0 ? b : a;
    reasons.push(
      `Précision globale : ${formatPercent(winner.overallFieldAccuracy)} contre ${formatPercent(loser.overallFieldAccuracy)} — écart décisif.`,
    );
    reasons.push(costAndLatencyNote(winner, loser));
    return { provider: winner.provider, reasons };
  }

  reasons.push(
    `Précisions comparables (${formatPercent(accuracyA)} vs ${formatPercent(accuracyB)}) — départage par le coût puis la latence.`,
  );
  const costA = a.cost.avgPerPhotoUsd;
  const costB = b.cost.avgPerPhotoUsd;
  if (costA !== null && costB !== null && costA !== costB) {
    const winner = costA < costB ? a : b;
    const loser = costA < costB ? b : a;
    reasons.push(
      `Coût moyen par photo : ${formatUsd(winner.cost.avgPerPhotoUsd)} contre ${formatUsd(loser.cost.avgPerPhotoUsd)}.`,
    );
    return { provider: winner.provider, reasons };
  }
  const winner = a.latency.avgMs <= b.latency.avgMs ? a : b;
  reasons.push(`Latence moyenne : ${winner.latency.avgMs} ms (meilleure).`);
  return { provider: winner.provider, reasons };
}

function costAndLatencyNote(winner: BenchProviderAggregate, loser: BenchProviderAggregate): string {
  return (
    `Pour référence — coût/photo : ${formatUsd(winner.cost.avgPerPhotoUsd)} (retenu) vs ` +
    `${formatUsd(loser.cost.avgPerPhotoUsd)} ; latence moyenne : ${winner.latency.avgMs} ms vs ${loser.latency.avgMs} ms.`
  );
}

/* ------------------------------ Rapport -------------------------------- */

export interface BenchReportMeta {
  photosDir: string;
  truthCsv: string;
  generatedAt: Date;
  matchingEvaluated: boolean;
}

const MODE_LABELS: Record<AiAnalysisMode, string> = {
  EQUIPMENT_LABEL: 'A — plaque signalétique',
  FILTER_FRAME: 'B — cadre du filtre',
};

/** Rend le rapport complet `docs/ia-banc-essai.md` (Markdown, en français). */
export function renderBenchReport(
  results: BenchCaseResult[],
  aggregates: BenchProviderAggregate[],
  meta: BenchReportMeta,
): string {
  const recommendation = recommendProvider(aggregates);
  const lines: string[] = [];

  lines.push('# Banc d’essai vision IA — Claude vs GPT (tâche 17)');
  lines.push('');
  lines.push(
    `> Généré le ${meta.generatedAt.toISOString()} par \`pnpm --filter @ffc/api ai:bench\`.`,
  );
  lines.push(`> Photos : \`${meta.photosDir}\` · vérité terrain : \`${meta.truthCsv}\`.`);
  lines.push('');
  lines.push('## Méthodologie');
  lines.push('');
  lines.push(
    '- Chaque photo passe par le MÊME assainissement qu’en production (ré-encodage JPEG sans EXIF, grand côté ≤ 2048 px), puis par les deux fournisseurs avec les prompts et la sortie structurée du pipeline.',
  );
  lines.push(
    '- Précision par champ : fabricant et numéro de modèle normalisés (casse/tirets/espaces), dimensions résolues par le référentiel de tailles (nominal ↔ réel, orientation indifférente), MERV exact.',
  );
  lines.push(
    meta.matchingEvaluated
      ? '- Taux de correspondance : part des extractions menant à une correspondance en base (equipment_models/variantes) via le même service de matching qu’en production.'
      : '- Taux de correspondance : NON évalué (base de données indisponible pendant l’exécution).',
  );
  lines.push(
    '- Coût réel par photo : jetons consommés × tarifs publics (voir `vision-pricing.ts`).',
  );
  lines.push('');

  for (const aggregate of aggregates) {
    lines.push(`## ${aggregate.provider} — \`${aggregate.model}\``);
    lines.push('');
    lines.push(
      `${aggregate.okCases}/${aggregate.cases} analyses abouties · latence moyenne ${aggregate.latency.avgMs} ms (p50 ${aggregate.latency.p50Ms} ms, max ${aggregate.latency.maxMs} ms) · ` +
        `jetons ${aggregate.tokens.input.toLocaleString('fr-CA')} entrée / ${aggregate.tokens.output.toLocaleString('fr-CA')} sortie.`,
    );
    lines.push('');
    lines.push(
      '| Mode | Cas | Fabricant | Numéro de modèle | Dimensions | MERV | Correspondance |',
    );
    lines.push('|---|---|---|---|---|---|---|');
    for (const [mode, modeAggregate] of Object.entries(aggregate.byMode) as [
      AiAnalysisMode,
      BenchModeAggregate,
    ][]) {
      lines.push(
        `| ${MODE_LABELS[mode]} | ${modeAggregate.okCases}/${modeAggregate.cases} | ` +
          `${formatRatio(modeAggregate.fields.manufacturer)} | ${formatRatio(modeAggregate.fields.modelNumber)} | ` +
          `${formatRatio(modeAggregate.fields.dimensions)} | ${formatRatio(modeAggregate.fields.merv)} | ` +
          `${formatRatio(modeAggregate.matchRate)} |`,
      );
    }
    lines.push('');
    lines.push(
      `**Coût réel** : ${formatUsd(aggregate.cost.avgPerPhotoUsd)} par photo en moyenne` +
        (aggregate.cost.totalUsd !== null
          ? ` (total ${formatUsd(aggregate.cost.totalUsd)} pour ${aggregate.cost.pricedCases} photos tarifées).`
          : ' (tarif du modèle inconnu — compléter `vision-pricing.ts`).'),
    );
    lines.push('');
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    lines.push('## Analyses en échec');
    lines.push('');
    lines.push('| Photo | Fournisseur | Erreur |');
    lines.push('|---|---|---|');
    for (const failure of failures) {
      lines.push(`| ${failure.file} | ${failure.provider} | ${failure.error ?? '?'} |`);
    }
    lines.push('');
  }

  lines.push('## Recommandation');
  lines.push('');
  if (recommendation.provider) {
    lines.push(`**Fournisseur recommandé : ${recommendation.provider}.**`);
    lines.push('');
    for (const reason of recommendation.reasons) lines.push(`- ${reason}`);
  } else {
    for (const reason of recommendation.reasons) lines.push(`- ${reason}`);
  }
  lines.push('');
  lines.push('## Détail des cas');
  lines.push('');
  lines.push(
    '| Photo | Mode | Fournisseur | Champs (fab/modèle/dim/MERV) | Corresp. | Latence | Coût |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const result of results) {
    const fields = (['manufacturer', 'modelNumber', 'dimensions', 'merv'] as const)
      .map((key) => formatScore(result.fields[key]))
      .join(' ');
    lines.push(
      `| ${result.file} | ${result.mode === 'EQUIPMENT_LABEL' ? 'A' : 'B'} | ${result.provider} | ${result.ok ? fields : 'éch.'} | ` +
        `${result.matched === null ? '—' : result.matched ? '✔' : '✘'} | ${result.latencyMs} ms | ${formatUsd(result.costUsd)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function formatScore(score: boolean | null): string {
  return score === null ? '—' : score ? '✔' : '✘';
}

function formatRatio(aggregate: BenchFieldAggregate): string {
  if (aggregate.evaluated === 0) return '—';
  return `${Math.round((aggregate.correct / aggregate.evaluated) * 100)} % (${aggregate.correct}/${aggregate.evaluated})`;
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/d' : `${Math.round(value * 1000) / 10} %`;
}

function formatUsd(value: number | null): string {
  return value === null ? 'n/d' : `${value.toFixed(4)} $ US`;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export { callCostUsd };
