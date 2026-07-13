import sharp from 'sharp';

/**
 * Validation du CONTENU réel des photos téléversées (tâche 17) — jamais
 * l'extension ni le Content-Type déclaré : un exécutable renommé `.jpg`
 * doit être rejeté sur ses octets.
 *
 * Formats acceptés : JPEG, PNG, WebP, HEIC (photos iPhone). Nuance HEIC :
 * les binaires précompilés de sharp/libvips ne décodent pas le HEVC
 * (brevets) — la signature est reconnue, mais si le décodage échoue, la
 * soumission répond 400 avec un message clair invitant à convertir en JPEG
 * (l'app mobile, tâche 19, convertira côté client). Documenté dans docs/ia.md.
 */

export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

/** Marques HEIF acceptées dans la boîte `ftyp` (famille HEIC + conteneurs mif1/msf1). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/**
 * Détecte le type d'image par OCTETS MAGIQUES. Retourne null si le contenu
 * n'est pas une image acceptée (exécutable, PDF, SVG, GIF…).
 */
export function detectImageType(bytes: Buffer): DetectedImageType | null {
  if (bytes.length < 12) return null;

  // JPEG : FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';

  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP : « RIFF » .... « WEBP »
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  // HEIC/HEIF : boîte ISO-BMFF « ftyp » à l'offset 4, marque majeure HEIF.
  if (bytes.toString('latin1', 4, 8) === 'ftyp') {
    const majorBrand = bytes.toString('latin1', 8, 12).trim().toLowerCase();
    if (HEIF_BRANDS.has(majorBrand)) return 'image/heic';
  }

  return null;
}

export interface SanitizedImage {
  /** JPEG ré-encodé, SANS métadonnées (EXIF/GPS/ICC retirés). */
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Borne le grand côté de l'image assainie : suffisant pour lire une plaque
 * signalétique ou un cadre de filtre, et réduit les octets envoyés au
 * fournisseur de vision (coût/latence).
 */
const MAX_SANITIZED_EDGE_PX = 2048;

export class ImageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

/**
 * Ré-encode la photo en JPEG en retirant TOUTES les métadonnées — dont les
 * coordonnées GPS de l'EXIF (Loi 25 : on ne conserve jamais la position du
 * domicile du client). `rotate()` applique d'abord l'orientation EXIF pour
 * que l'image reste droite une fois l'EXIF disparu.
 *
 * Lève `ImageDecodeError` si les octets ne se décodent pas (image corrompue,
 * ou HEIC sans décodeur HEVC dans le binaire sharp précompilé).
 */
export async function sanitizeImage(bytes: Buffer): Promise<SanitizedImage> {
  try {
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({
        width: MAX_SANITIZED_EDGE_PX,
        height: MAX_SANITIZED_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    throw new ImageDecodeError(error instanceof Error ? error.message : String(error));
  }
}
