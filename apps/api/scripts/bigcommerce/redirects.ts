/**
 * Génération de la table de redirections 301 de bascule — tâche 25 §1/§3.
 *
 * Usage (depuis apps/api, base dev peuplée par bigcommerce:import) :
 *   pnpm --filter @ffc/api bigcommerce:redirects
 *
 * Sources croisées :
 *  - data/urls-bigcommerce.csv (tâche 08 : URLs officielles + id appariés),
 *  - data/urls-crawl.csv (bigcommerce:crawl : sitemaps publics + BFS),
 *  - data/redirections-decisions.json (décisions humaines versionnées),
 *  - base Prisma (slugs ACTUELS des produits ACTIVE / catégories actives),
 *  - référentiel de tailles de @ffc/core.
 *
 * Écrit :
 *  - apps/web/src/redirects/redirects.generated.json (artefact du middleware),
 *  - data/redirections-ecarts.json (écarts + ignorés, machine),
 *  - rapport-redirections.md à la racine (rapport humain).
 *
 * Code de sortie 1 si au moins un écart : le rapport d'écarts est BLOQUANT,
 * la bascule ne part pas tant que chaque URL n'a pas une décision explicite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { type RedirectSourceType } from '@ffc/core';
import {
  buildRedirects,
  loadCatalogTargets,
  type CatalogTargets,
  type RedirectDecisionRow,
  type RedirectHostConfig,
  type RedirectSourceRow,
} from '../../src/bigcommerce/redirects';

const repoRoot = join(__dirname, '..', '..', '..', '..');

const SOURCE_TYPES: readonly RedirectSourceType[] = [
  'product',
  'category',
  'page',
  'brand',
  'blog',
  'other',
];

const decisionsSchema = z.array(
  z.object({
    host: z.string().min(1),
    path: z.string().min(1),
    action: z.enum(['redirect', 'gone', 'pending']),
    to: z.string().min(1).optional(),
    reason: z.string().min(1),
  }),
);

function canonicalHost(domain: string): string {
  return `www.${domain.replace(/^www\./, '')}`;
}

/** Découpe une ligne CSV (guillemets doublés à la RFC 4180). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function readCsv(path: string, expectedHeader: string): string[][] {
  const body = readFileSync(path, 'utf8');
  const lines = body.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines[0] !== expectedHeader) {
    throw new Error(
      `En-tête inattendu dans ${path} : « ${lines[0]} » (attendu « ${expectedHeader} »)`,
    );
  }
  return lines.slice(1).map(parseCsvLine);
}

function asSourceType(value: string, context: string): RedirectSourceType {
  if ((SOURCE_TYPES as readonly string[]).includes(value)) return value as RedirectSourceType;
  throw new Error(`Type de source inconnu « ${value} » (${context})`);
}

function loadCsvSources(hostByDomain: Map<string, string>): RedirectSourceRow[] {
  const path = join(repoRoot, 'data', 'urls-bigcommerce.csv');
  const rows = readCsv(path, 'domaine,type,url,identifiant_apparie');
  return rows.map(([domain, type, url, matchedId], index) => {
    const host = hostByDomain.get(canonicalHost(domain ?? ''));
    if (!host) throw new Error(`Domaine inconnu ligne ${index + 2} de ${path} : ${domain}`);
    return {
      host,
      type: asSourceType(type ?? '', `${path} ligne ${index + 2}`),
      path: url ?? '',
      ...(matchedId ? { matchedId } : {}),
      origin: 'csv' as const,
    };
  });
}

function loadCrawlSources(hostByDomain: Map<string, string>): RedirectSourceRow[] {
  const path = join(repoRoot, 'data', 'urls-crawl.csv');
  if (!existsSync(path)) {
    throw new Error(
      `${path} introuvable — lancer d'abord : pnpm --filter @ffc/api bigcommerce:crawl`,
    );
  }
  const rows = readCsv(path, 'domaine,type,url,source,statut');
  return rows.map(([domain, type, url], index) => {
    const host = hostByDomain.get(canonicalHost(domain ?? ''));
    if (!host) throw new Error(`Domaine inconnu ligne ${index + 2} de ${path} : ${domain}`);
    return {
      host,
      type: asSourceType(type ?? '', `${path} ligne ${index + 2}`),
      path: url ?? '',
      origin: 'crawl' as const,
    };
  });
}

function loadDecisions(): RedirectDecisionRow[] {
  const path = join(repoRoot, 'data', 'redirections-decisions.json');
  if (!existsSync(path)) {
    throw new Error(`${path} introuvable — décisions versionnées obligatoires.`);
  }
  const parsed = decisionsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Décisions invalides dans ${path} :\n${parsed.error.message}`);
  }
  return parsed.data;
}

function formatCoverageTable(
  hosts: RedirectHostConfig[],
  coverage: Record<
    string,
    Partial<
      Record<
        RedirectSourceType,
        { total: number; exact: number; gone: number; pending: number; ignored: number }
      >
    >
  >,
  markdown: boolean,
): string {
  const lines: string[] = [];
  for (const { host } of hosts) {
    const byType = coverage[host] ?? {};
    lines.push(markdown ? `### ${host}` : host);
    const header = ['type', 'total', 'exactes', '410', 'en attente', 'ignorées'];
    const rows = SOURCE_TYPES.filter((type) => byType[type]).map((type) => {
      const cell = byType[type]!;
      return [
        type,
        String(cell.total),
        String(cell.exact),
        String(cell.gone),
        String(cell.pending),
        String(cell.ignored),
      ];
    });
    if (markdown) {
      lines.push('', `| ${header.join(' | ')} |`, `|${header.map(() => '---|').join('')}`);
      for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
      lines.push('');
    } else {
      const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
      );
      lines.push(`  ${header.map((h, i) => h.padEnd(widths[i] ?? h.length)).join('  ')}`);
      for (const row of rows) {
        lines.push(`  ${row.map((v, i) => v.padEnd(widths[i] ?? v.length)).join('  ')}`);
      }
    }
  }
  return lines.join('\n');
}

function groupByReason<T extends { reason: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.reason) ?? [];
    list.push(row);
    groups.set(row.reason, list);
  }
  return groups;
}

async function main(): Promise<void> {
  const hosts: RedirectHostConfig[] = [
    {
      host: canonicalHost(process.env.BIGCOMMERCE_DOMAIN_EN ?? 'furnacefilterscanada.com'),
      locale: 'en',
      aliases: [
        (process.env.BIGCOMMERCE_DOMAIN_EN ?? 'furnacefilterscanada.com').replace(/^www\./, ''),
      ],
    },
    {
      host: canonicalHost(process.env.BIGCOMMERCE_DOMAIN_FR ?? 'filtrationmontreal.com'),
      locale: 'fr',
      aliases: [
        (process.env.BIGCOMMERCE_DOMAIN_FR ?? 'filtrationmontreal.com').replace(/^www\./, ''),
      ],
    },
  ];
  const hostByDomain = new Map(hosts.map((config) => [config.host, config.host]));

  const csvSources = loadCsvSources(hostByDomain);
  const crawlSources = loadCrawlSources(hostByDomain);
  const decisions = loadDecisions();

  const prisma = new PrismaClient();
  let targets: CatalogTargets;
  try {
    targets = await loadCatalogTargets(prisma);
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    `Sources : ${csvSources.length} lignes CSV, ${crawlSources.length} lignes crawl, ` +
      `${decisions.length} décisions; base : ${targets.products.size} produits, ` +
      `${targets.categories.size} catégories, ${targets.sizeLabels.size} tailles.`,
  );

  const { artifact, gaps, ignored } = buildRedirects({
    hosts,
    sources: [...csvSources, ...crawlSources],
    decisions,
    targets,
  });

  const artifactPath = join(
    repoRoot,
    'apps',
    'web',
    'src',
    'redirects',
    'redirects.generated.json',
  );
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  const ecartsPath = join(repoRoot, 'data', 'redirections-ecarts.json');
  writeFileSync(
    ecartsPath,
    JSON.stringify({ generatedAt: artifact.generatedAt, gaps, ignored }, null, 2) + '\n',
    'utf8',
  );

  const totalExact = Object.values(artifact.hosts).reduce(
    (sum, table) => sum + Object.keys(table.exact).length,
    0,
  );
  const totalGone = Object.values(artifact.hosts).reduce(
    (sum, table) => sum + table.gone.length,
    0,
  );

  const report: string[] = [
    '# Rapport de génération des redirections 301 — bascule BigCommerce (tâche 25)',
    '',
    `Généré le ${artifact.generatedAt} par \`pnpm --filter @ffc/api bigcommerce:redirects\`.`,
    '',
    '## Sources croisées',
    '',
    `- \`data/urls-bigcommerce.csv\` (tâche 08) : ${csvSources.length} lignes`,
    `- \`data/urls-crawl.csv\` (sitemaps publics + BFS) : ${crawlSources.length} lignes`,
    `- \`data/redirections-decisions.json\` : ${decisions.length} décisions versionnées`,
    `- Base Prisma : ${targets.products.size} produits ACTIVE appariés, ${targets.categories.size} catégories actives appariées`,
    '',
    '## Résultat',
    '',
    `- **${totalExact} redirections exactes** et **${totalGone} URLs en 410 assumé** dans \`apps/web/src/redirects/redirects.generated.json\``,
    `- **${gaps.length} écart(s) bloquant(s)** (détail ci-dessous et dans \`data/redirections-ecarts.json\`)`,
    `- ${ignored.length} URL(s) ignorée(s) à bon droit (racine, robots.txt, sitemap.xml, URLs vides)`,
    '',
    '## Couverture par hôte',
    '',
    formatCoverageTable(hosts, artifact.coverage.byHost, true),
  ];

  if (gaps.length > 0) {
    report.push(`## Écarts bloquants (${gaps.length})`, '');
    report.push(
      'Chaque écart doit recevoir une décision explicite dans',
      '`data/redirections-decisions.json` (cible argumentée, 410 assumé, ou',
      'déblocage amont : import FR, rapport SEO du blogue). **Jamais de 301 par',
      'défaut vers l’accueil.**',
      '',
    );
    for (const [reason, rows] of groupByReason(gaps)) {
      report.push(`### ${reason} — ${rows.length} URL(s)`, '');
      for (const row of rows) {
        report.push(`- \`${row.host}${row.path}\`${row.id ? ` (id \`${row.id}\`)` : ''}`);
      }
      report.push('');
    }
  } else {
    report.push('## Écarts bloquants', '', 'Aucun. ✅', '');
  }

  if (ignored.length > 0) {
    report.push(`## URLs ignorées (${ignored.length})`, '');
    for (const [reason, rows] of groupByReason(ignored)) {
      report.push(`### ${reason} — ${rows.length} URL(s)`, '');
      for (const row of rows) {
        report.push(
          `- \`${row.host}\` : \`${row.path || '(chemin vide)'}\`${row.id ? ` (id \`${row.id}\`)` : ''}`,
        );
      }
      report.push('');
    }
  }

  report.push(
    '## Régénération',
    '',
    '1. Base dev à jour : `pnpm --filter @ffc/api bigcommerce:import` (import EN réel).',
    '2. Inventaire frais : `pnpm --filter @ffc/api bigcommerce:crawl`.',
    '3. `pnpm --filter @ffc/api bigcommerce:redirects` — échoue (code 1) tant qu’il reste un écart.',
    '4. Commiter l’artefact, les écarts et ce rapport ensemble.',
    '',
  );

  const reportPath = join(repoRoot, 'rapport-redirections.md');
  writeFileSync(reportPath, report.join('\n'), 'utf8');

  console.log('');
  console.log(formatCoverageTable(hosts, artifact.coverage.byHost, false));
  console.log('');
  console.log(`Artefact : ${artifactPath} (${totalExact} exactes, ${totalGone} en 410)`);
  console.log(`Écarts : ${ecartsPath} (${gaps.length} bloquant(s), ${ignored.length} ignoré(s))`);
  console.log(`Rapport : ${reportPath}`);

  if (gaps.length > 0) {
    console.error(
      `\n⛔ ${gaps.length} écart(s) sans décision — bascule impossible en l'état (voir rapport-redirections.md).`,
    );
    process.exitCode = 1;
  }
}

void main();
