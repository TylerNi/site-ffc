import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Primitives cryptographiques de l'authentification (tâche 05).
 *
 * Règle du projet : AUCUN jeton ni secret en clair en base.
 *   - Jetons porteurs (refresh, usage unique, panier invité) : 256 bits
 *     aléatoires, stockés en SHA-256. Pas besoin de hachage lent : l'entropie
 *     rend la force brute hors de portée, contrairement aux mots de passe
 *     (qui passent par Argon2id — voir password.ts).
 *   - Secrets TOTP : chiffrés AES-256-GCM (il faut pouvoir les relire pour
 *     valider les codes), clé hors base (APP_ENCRYPTION_KEY).
 */

/** Jeton opaque URL-safe de 256 bits (43 caractères base64url). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Empreinte SHA-256 (hex) — forme stockée des jetons opaques. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Comparaison à temps constant de deux chaînes hex de même longueur. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Code de secours MFA lisible : 2 groupes de 5 caractères Crockford
 * (sans I/L/O/U ambigus) ≈ 50 bits d'entropie. Ex. « 7KF2M-9XQ4R ».
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function generateRecoveryCode(): string {
  const pick = (length: number): string =>
    Array.from({ length }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${pick(5)}-${pick(5)}`;
}

/* ------------------------------------------------------------------ */
/* Chiffrement applicatif AES-256-GCM (secrets TOTP)                    */
/* ------------------------------------------------------------------ */

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/** Chiffre `plaintext` → base64(iv ‖ ciphertext ‖ tag). */
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** Déchiffre la sortie de `encryptSecret`. Lance si la clé ou le tag est invalide. */
export function decryptSecret(payloadBase64: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const payload = Buffer.from(payloadBase64, 'base64');
  const iv = payload.subarray(0, GCM_IV_LENGTH);
  const tag = payload.subarray(payload.length - GCM_TAG_LENGTH);
  const ciphertext = payload.subarray(GCM_IV_LENGTH, payload.length - GCM_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
