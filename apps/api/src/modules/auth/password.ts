import argon2 from 'argon2';

/**
 * Hachage des mots de passe — Argon2id (RFC 9106).
 *
 * Paramètres (justification complète dans docs/auth.md) :
 *   - memoryCost 64 MiB : au-dessus du minimum OWASP 2024 (19 MiB), rend le
 *     craquage GPU/ASIC coûteux tout en restant raisonnable pour une tâche
 *     ECS (~64 Mo alloués ~100 ms par vérification).
 *   - timeCost 3 passes : compromis latence/résistance recommandé avec
 *     cette mémoire.
 *   - parallelism 1 : une seule voie — pas de compétition de threads sous
 *     charge; la protection vient de la mémoire, pas du parallélisme.
 *
 * Le sel (16 octets) et les paramètres sont encodés dans la chaîne PHC
 * produite : ils pourront être renforcés plus tard sans migration (les
 * anciens hachages restent vérifiables, à re-hacher à la connexion).
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // KiB → 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Hachage corrompu ou format inconnu : on refuse sans lancer.
    return false;
  }
}

/**
 * Hachage factice pré-calculé : vérifié quand le compte n'existe pas ou n'a
 * pas de mot de passe, pour que « courriel inconnu » et « mot de passe
 * erroné » prennent le même temps (anti-énumération par chronométrage).
 */
let dummyHashPromise: Promise<string> | null = null;
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword('mot-de-passe-factice-anti-enumeration');
  await verifyPassword(await dummyHashPromise, password);
}
