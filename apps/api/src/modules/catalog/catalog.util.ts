import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Outils transverses du catalogue : pagination par CURSEUR (keyset stable),
 * prédicats keyset SQL et en-têtes de cache publics.
 */

/** Valeur d'une clé de tri encodée dans un curseur. */
export type CursorValue = string | number | boolean;

/**
 * Encode un curseur opaque (base64url d'un JSON) à partir des valeurs des
 * clés de tri de la dernière ligne de la page. Opaque côté client : sa forme
 * peut changer sans casser l'API tant que decode/encode restent cohérents.
 */
export function encodeCursor(values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/** Décode un curseur en tableau de valeurs, ou lève une 400 si corrompu. */
export function decodeCursor(cursor: string, expectedLength: number): CursorValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Curseur de pagination invalide.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedLength ||
    !parsed.every((v) => ['string', 'number', 'boolean'].includes(typeof v))
  ) {
    throw new BadRequestException('Curseur de pagination invalide.');
  }
  return parsed as CursorValue[];
}

/** Une clé de tri : expression SQL, direction, et valeur du curseur (au décodage). */
export interface KeysetKey {
  readonly sql: Prisma.Sql;
  readonly direction: 'ASC' | 'DESC';
  readonly value: CursorValue;
  /** Cast du paramètre (ex. « uuid » pour comparer une colonne uuid). */
  readonly cast?: 'uuid';
}

/** Paramètre du curseur, casté au besoin (uuid comparé à une colonne uuid). */
function cursorParam(key: KeysetKey): Prisma.Sql {
  return key.cast === 'uuid' ? Prisma.sql`${key.value}::uuid` : Prisma.sql`${key.value}`;
}

/**
 * Prédicat keyset « strictement après le curseur » pour un tri multi-clés,
 * directions mixtes permises. Développe la comparaison lexicographique :
 *   (k1 OP v1) OR (k1 = v1 AND k2 OP v2) OR …
 * La dernière clé DOIT être unique (id) pour un ordre total → pagination stable.
 */
export function keysetPredicate(keys: readonly KeysetKey[]): Prisma.Sql {
  const terms: Prisma.Sql[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const conjuncts: Prisma.Sql[] = [];
    for (let j = 0; j < i; j += 1) {
      const key = keys[j]!;
      conjuncts.push(Prisma.sql`${key.sql} = ${cursorParam(key)}`);
    }
    const last = keys[i]!;
    const operator = last.direction === 'ASC' ? Prisma.sql`>` : Prisma.sql`<`;
    conjuncts.push(Prisma.sql`${last.sql} ${operator} ${cursorParam(last)}`);
    terms.push(Prisma.sql`(${Prisma.join(conjuncts, ' AND ')})`);
  }
  return Prisma.sql`(${Prisma.join(terms, ' OR ')})`;
}

/** Clause ORDER BY correspondant aux clés keyset (même ordre, mêmes directions). */
export function orderByClause(keys: readonly KeysetKey[]): Prisma.Sql {
  const parts = keys.map((key) =>
    key.direction === 'ASC' ? Prisma.sql`${key.sql} ASC` : Prisma.sql`${key.sql} DESC`,
  );
  return Prisma.join(parts, ', ');
}

/** Combine des prédicats optionnels en une clause `AND …` (ou vide). */
export function andWhere(predicates: readonly (Prisma.Sql | undefined)[]): Prisma.Sql {
  const active = predicates.filter((p): p is Prisma.Sql => p !== undefined);
  if (active.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(active, ' AND ')}`;
}

/** Bornes de pagination : limite demandée bornée à [1, 60]. */
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/**
 * En-têtes de cache publics des endpoints de lecture. Les pages ISR de la
 * vitrine (tâche 07) et le CDN Cloudflare s'appuient dessus. `s-maxage` cible
 * le cache partagé (CDN), `stale-while-revalidate` sert une version tiède
 * pendant la revalidation en arrière-plan.
 */
export const CACHE_CONTROL = {
  /** Catégories et index des tailles : changent rarement. */
  long: 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400',
  /** Listes et fiches produits : prix/stock plus volatils. */
  medium: 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
  /** Recherche et autocomplétion : très volatiles, cache court. */
  short: 'public, max-age=15, s-maxage=30, stale-while-revalidate=120',
} as const;
