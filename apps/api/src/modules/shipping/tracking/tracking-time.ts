/**
 * Horodatages des transporteurs → `Date` UTC.
 *
 * Chaque transporteur a sa convention :
 *   - Postes Canada donne date + heure + ABRÉVIATION de fuseau (« EDT ») ;
 *   - Canpar et Purolator donnent des heures LOCALES sans fuseau — leurs
 *     réseaux sont pilotés de l'Est canadien, on les interprète en heure de
 *     l'Est (précision ±1 fuseau pour les scans hors Est : acceptable pour
 *     une chronologie de colis, et stable pour la déduplication).
 */

/** Abréviations de fuseaux nord-américains → décalage UTC (heures). */
const TZ_OFFSET_HOURS: Record<string, number> = {
  NDT: -2.5,
  NST: -3.5,
  ADT: -3,
  AST: -4,
  EDT: -4,
  EST: -5,
  CDT: -5,
  CST: -6,
  MDT: -6,
  MST: -7,
  PDT: -7,
  PST: -8,
  UTC: 0,
  GMT: 0,
};

/**
 * « 2026-07-14 » + « 16:23:11 » + « EDT » → Date UTC. Fuseau inconnu ou
 * absent : heure de l'Est (voir note d'en-tête).
 */
export function zonedToUtc(date: string, time: string, timeZone?: string | null): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!match || !timeMatch) return null;

  const [, year, month, day] = match;
  const [, hours, minutes, seconds] = timeMatch;
  const offset =
    TZ_OFFSET_HOURS[(timeZone ?? '').trim().toUpperCase()] ??
    easternOffsetHours(Number(year), Number(month), Number(day));

  const civilMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds ?? '0'),
  );
  // `Date.UTC` déborde en silence (mois 13 → janvier suivant, 25 h → le
  // lendemain) : les composantes relues doivent être exactement celles reçues.
  const civil = new Date(civilMs);
  if (
    Number.isNaN(civilMs) ||
    civil.getUTCFullYear() !== Number(year) ||
    civil.getUTCMonth() !== Number(month) - 1 ||
    civil.getUTCDate() !== Number(day) ||
    civil.getUTCHours() !== Number(hours) ||
    civil.getUTCMinutes() !== Number(minutes) ||
    civil.getUTCSeconds() !== Number(seconds ?? '0')
  ) {
    return null;
  }
  return new Date(civilMs - offset * 3_600_000);
}

/**
 * Décalage de l'heure de l'Est pour une date donnée. L'heure avancée court
 * du deuxième dimanche de mars au premier dimanche de novembre (règle
 * nord-américaine depuis 2007) — approximation au jour près suffisante ici.
 */
export function easternOffsetHours(year: number, month: number, day: number): number {
  const dstStart = nthSundayOfMonth(year, 3, 2);
  const dstEnd = nthSundayOfMonth(year, 11, 1);
  const date = Date.UTC(year, month - 1, day);
  return date >= dstStart && date < dstEnd ? -4 : -5;
}

/** Timestamp UTC (minuit) du n-ième dimanche d'un mois. */
function nthSundayOfMonth(year: number, month: number, nth: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offsetToSunday = (7 - first.getUTCDay()) % 7;
  return Date.UTC(year, month - 1, 1 + offsetToSunday + (nth - 1) * 7);
}

/**
 * Date SANS heure (« 2026-07-15 ») → Date à midi UTC : elle s'affiche le
 * même jour civil dans tous les fuseaux nord-américains (ETA de livraison).
 */
export function dateOnlyToUtcNoon(date: string | null | undefined): Date | null {
  if (!date) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
  if (!match) return null;
  const parsed = new Date(`${match[1]}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
