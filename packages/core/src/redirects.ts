import { type Locale } from './locales';

/**
 * Redirections 301 de la bascule BigCommerce → plateforme maison (tâche 25).
 *
 * Contrat PARTAGÉ entre le générateur (apps/api, scripts/bigcommerce) et le
 * middleware de la vitrine (apps/web/src/redirects) : les deux côtés
 * normalisent les chemins avec exactement la même fonction et lisent le même
 * artefact JSON versionné (`apps/web/src/redirects/redirects.generated.json`).
 * Toute évolution du format passe par ici — jamais de copie locale.
 */

/** Nom de la variable d'environnement qui active le middleware (interrupteur
 *  de sûreté : absente ou ≠ '1' ⇒ middleware inerte, rien en production
 *  avant la bascule). */
export const REDIRECTS_ENV_FLAG = 'REDIRECTS_ENABLED';

/** Types de contenu source (côté BigCommerce). */
export type RedirectSourceType = 'product' | 'category' | 'page' | 'brand' | 'blog' | 'other';

export interface RedirectEntry {
  /** Chemin cible sur le MÊME domaine (absolu, sans hôte), déjà localisé. */
  to: string;
  /** Type de la source — rapport de couverture et diagnostic. */
  type: RedirectSourceType;
  /** identifiant_apparie BigCommerce (`en:34`, `fr:page:7`…) si connu. */
  id?: string;
}

export interface RedirectHostTable {
  locale: Locale;
  /** Origine canonique servie (protocole + hôte), ex. `https://www.exemple.com`. */
  origin: string;
  /** Hôtes non canoniques ramenés à l'origine canonique (ex. apex sans www). */
  aliases: string[];
  /** Chemin normalisé (voir `normalizeRedirectPath`) → cible. */
  exact: Record<string, RedirectEntry>;
  /** Chemins normalisés volontairement abandonnés → 410 assumé. */
  gone: string[];
}

export interface RedirectCoverageCell {
  total: number;
  exact: number;
  gone: number;
  pending: number;
  ignored: number;
}

export interface RedirectCoverage {
  /** hôte canonique → type de source → comptes. */
  byHost: Record<string, Partial<Record<RedirectSourceType, RedirectCoverageCell>>>;
}

export interface RedirectArtifact {
  version: 1;
  generatedAt: string;
  /** Provenances utilisées à la génération (traçabilité du run). */
  sources: { csvRows: number; crawlRows: number; decisions: number };
  hosts: Record<string, RedirectHostTable>;
  coverage: RedirectCoverage;
}

/**
 * Paramètres de suivi marketing PRÉSERVÉS tels quels sur la cible d'une
 * redirection. Tout autre paramètre d'une vieille URL BigCommerce (tri,
 * pagination, facettes, `action=`…) est abandonné : la cible est la page
 * canonique.
 */
export const TRACKING_PARAM_ALLOWLIST: readonly string[] = [
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ttclid',
  'mc_cid',
  'mc_eid',
];

/** `true` si le paramètre de requête doit suivre la redirection. */
export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAM_ALLOWLIST.includes(lower);
}

/**
 * Normalisation canonique d'un chemin pour le lookup de redirection — la MÊME
 * à la génération (clés de l'artefact) et à l'exécution (middleware) :
 *
 *  1. décodage percent-encoding (chemin gardé tel quel s'il est mal encodé),
 *  2. minuscules + normalisation Unicode NFC,
 *  3. barre oblique de tête garantie, doubles barres réduites,
 *  4. barre oblique finale retirée (sauf racine).
 *
 * `/index.php` n'est PAS réécrit ici : c'est une entrée exacte de la table
 * (décision versionnée), pas une règle de normalisation.
 */
export function normalizeRedirectPath(rawPath: string): string {
  let path = rawPath.trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    // Encodage invalide : on compare la forme brute.
  }
  path = path.toLowerCase().normalize('NFC');
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
