/**
 * Banc d'essai comparatif Claude vs GPT — tâche 17.
 *
 * Usage (depuis la racine) :
 *   pnpm --filter @ffc/api ai:bench -- --dossier <photos> --attendu <verite.csv> \
 *        [--sortie docs/ia-banc-essai.md] [--sans-correspondance]
 *
 * Exécute les DEUX fournisseurs configurés (ANTHROPIC_API_KEY / OPENAI_API_KEY,
 * modèles ANTHROPIC_VISION_MODEL / OPENAI_VISION_MODEL) sur chaque photo du
 * dossier listée dans le CSV de vérité, en passant par le MÊME assainissement,
 * les MÊMES prompts et la MÊME sortie structurée que la production, puis
 * produit `docs/ia-banc-essai.md` : précision par champ et par mode, taux de
 * correspondance en base, latence, coût réel par photo (jetons × tarifs) et
 * recommandation motivée.
 *
 * CSV attendu (en-tête obligatoire, champs vides = non évalués) :
 *   fichier,mode,fabricant,numero_modele,largeur,hauteur,profondeur,merv
 *   IMG_0012.jpg,EQUIPMENT_LABEL,Lennox,G61MPV-36B-070,,,,
 *   IMG_0013.jpg,B,,,16,25,1,11
 *
 * [À CONFIRMER : jeu de ~50 vraies photos à fournir par l'équipe — le script
 * accepte n'importe quel dossier.]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AiMatchingService } from '../src/modules/ai/ai-matching.service';
import {
  aggregateResults,
  type BenchCaseResult,
  parseTruthCsv,
  renderBenchReport,
  scoreExtraction,
  type BenchTruth,
} from '../src/modules/ai/bench/bench';
import { callCostUsd } from '../src/modules/ai/bench/vision-pricing';
import { AnthropicVisionProvider } from '../src/modules/ai/ai-vision/anthropic.provider';
import { OpenAiVisionProvider } from '../src/modules/ai/ai-vision/openai.provider';
import { type VisionProvider } from '../src/modules/ai/ai-vision/vision-provider';
import { sanitizeImage } from '../src/modules/ai/image-content';
import { type PrismaService } from '../src/database';

const repoRoot = join(__dirname, '..', '..', '..');

interface CliArgs {
  photosDir: string;
  truthCsv: string;
  outputPath: string;
  skipMatching: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const photosDir = get('--dossier');
  const truthCsv = get('--attendu');
  if (!photosDir || !truthCsv) {
    console.error(
      'Usage : pnpm --filter @ffc/api ai:bench -- --dossier <photos> --attendu <verite.csv> [--sortie docs/ia-banc-essai.md] [--sans-correspondance]',
    );
    process.exit(2);
  }
  return {
    photosDir: resolve(photosDir),
    truthCsv: resolve(truthCsv),
    outputPath: resolve(get('--sortie') ?? join(repoRoot, 'docs', 'ia-banc-essai.md')),
    skipMatching: argv.includes('--sans-correspondance'),
  };
}

function buildProviders(): VisionProvider[] {
  const providers: VisionProvider[] = [];
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (anthropicKey) {
    providers.push(
      new AnthropicVisionProvider(
        anthropicKey,
        process.env.ANTHROPIC_VISION_MODEL ?? 'claude-opus-4-8',
      ),
    );
  } else {
    console.warn('⚠ ANTHROPIC_API_KEY absente — Claude exclu du banc d’essai.');
  }
  if (openaiKey) {
    providers.push(
      new OpenAiVisionProvider(openaiKey, process.env.OPENAI_VISION_MODEL ?? 'gpt-5.1'),
    );
  } else {
    console.warn('⚠ OPENAI_API_KEY absente — GPT exclu du banc d’essai.');
  }
  if (providers.length === 0) {
    console.error(
      'Aucune clé API configurée (ANTHROPIC_API_KEY / OPENAI_API_KEY) — rien à comparer.',
    );
    process.exit(2);
  }
  return providers;
}

async function evaluateMatching(
  matching: AiMatchingService,
  truth: BenchTruth,
  extraction: NonNullable<Awaited<ReturnType<VisionProvider['analyze']>>>['extraction'],
): Promise<boolean> {
  if (truth.mode === 'EQUIPMENT_LABEL') {
    const outcome = await matching.matchEquipment(
      extraction.manufacturer.value,
      extraction.modelNumber.value,
    );
    return outcome.matchedEquipmentModelId !== null;
  }
  const variants = await matching.matchVariantsByDimensions(
    extraction.dimensions,
    extraction.merv.value,
  );
  return variants.length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const truths = parseTruthCsv(readFileSync(args.truthCsv, 'utf8'));
  console.log(`Banc d'essai : ${truths.length} photo(s) listée(s) dans ${args.truthCsv}.`);

  const providers = buildProviders();

  // Correspondance en base (optionnelle — nécessite DATABASE_URL joignable).
  let prisma: PrismaClient | null = null;
  let matching: AiMatchingService | null = null;
  if (!args.skipMatching) {
    try {
      prisma = new PrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      matching = new AiMatchingService(prisma as unknown as PrismaService);
    } catch {
      console.warn('⚠ Base de données injoignable — taux de correspondance non évalué.');
      await prisma?.$disconnect().catch(() => undefined);
      prisma = null;
      matching = null;
    }
  }

  const results: BenchCaseResult[] = [];
  for (const truth of truths) {
    const photoPath = join(args.photosDir, truth.file);
    if (!existsSync(photoPath)) {
      console.warn(`⚠ Photo absente du dossier, ignorée : ${truth.file}`);
      continue;
    }
    // Même assainissement qu'en production (EXIF retiré, JPEG ≤ 2048 px).
    const sanitized = await sanitizeImage(readFileSync(photoPath));

    for (const provider of providers) {
      process.stdout.write(`  ${truth.file} → ${provider.name}… `);
      try {
        const analysis = await provider.analyze({
          image: sanitized.data,
          mediaType: 'image/jpeg',
          mode: truth.mode,
        });
        const base: BenchCaseResult = {
          file: truth.file,
          mode: truth.mode,
          provider: provider.name,
          model: analysis.model,
          ok: true,
          error: null,
          latencyMs: analysis.latencyMs,
          usage: analysis.usage,
          costUsd: callCostUsd(analysis.model, analysis.usage),
          fields: scoreExtraction(truth, analysis.extraction),
          matched: null,
        };
        if (matching) {
          base.matched = await evaluateMatching(matching, truth, analysis.extraction);
        }
        results.push(base);
        console.log(`ok (${analysis.latencyMs} ms)`);
      } catch (error) {
        results.push({
          file: truth.file,
          mode: truth.mode,
          provider: provider.name,
          model: provider.model,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: 0,
          usage: null,
          costUsd: null,
          fields: { manufacturer: null, modelNumber: null, dimensions: null, merv: null },
          matched: null,
        });
        console.log('ÉCHEC');
      }
    }
  }

  await prisma?.$disconnect();

  if (results.length === 0) {
    console.error('Aucune photo analysée — vérifier le dossier et le CSV.');
    process.exit(2);
  }

  const aggregates = aggregateResults(results);
  const report = renderBenchReport(results, aggregates, {
    photosDir: args.photosDir,
    truthCsv: args.truthCsv,
    generatedAt: new Date(),
    matchingEvaluated: matching !== null,
  });
  writeFileSync(args.outputPath, `${report}\n`, 'utf8');
  console.log(`\nRapport écrit : ${args.outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
