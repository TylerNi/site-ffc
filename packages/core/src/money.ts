/**
 * Arithmétique monétaire ENTIÈRE (cents) — jamais de flottants.
 *
 * Sert au checkout (tâche 11) pour répartir une remise sur les lignes du
 * panier avant le calcul des taxes : la base d'imposition de chaque ligne
 * doit être exacte au cent et la somme des parts doit valoir exactement
 * le total réparti.
 */

/**
 * Répartit `totalCents` proportionnellement aux `weights` (méthode du plus
 * fort reste) : chaque part est un entier ≥ 0, la somme vaut EXACTEMENT
 * `totalCents`, et aucune part ne dépasse son poids (une remise ne rend
 * jamais une ligne négative quand total ≤ somme des poids).
 *
 * Poids nuls partout : tout revient à 0 (rien à répartir dessus).
 */
export function allocateProportionally(totalCents: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError(`Total à répartir invalide : ${totalCents}`);
  }
  if (weights.some((weight) => !Number.isInteger(weight) || weight < 0)) {
    throw new RangeError('Les poids de répartition doivent être des entiers ≥ 0');
  }

  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum === 0 || totalCents === 0) return weights.map(() => 0);
  if (totalCents > weightSum) {
    throw new RangeError(`Répartition impossible : ${totalCents} > somme des poids ${weightSum}`);
  }

  const total = BigInt(totalCents);
  const sum = BigInt(weightSum);
  const shares = weights.map((weight) => Number((BigInt(weight) * total) / sum));
  let remainder = totalCents - shares.reduce((acc, share) => acc + share, 0);

  // Plus fort reste : les cents restants vont aux plus grandes parts
  // fractionnaires (départage stable par index croissant).
  const byRemainder = weights
    .map((weight, index) => ({
      index,
      fraction: (BigInt(weight) * total) % sum,
      headroom: weight - shares[index]!,
    }))
    .sort((a, b) =>
      a.fraction === b.fraction ? a.index - b.index : b.fraction > a.fraction ? 1 : -1,
    );

  for (const candidate of byRemainder) {
    if (remainder === 0) break;
    if (candidate.headroom <= 0) continue;
    shares[candidate.index]! += 1;
    remainder -= 1;
  }

  return shares;
}
