import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectImageType, ImageDecodeError, sanitizeImage } from '../src/modules/ai/image-content';
import { MAX_AI_PHOTO_BYTES } from '../src/modules/ai/ai-photo-storage';
import { parseVisionExtraction } from '../src/modules/ai/ai-vision/vision-schema';
import { makeExe, makeJpeg } from './ai-helpers';

/**
 * Validation du contenu des photos (tâche 17) : détection par octets
 * magiques (jamais l'extension), assainissement sharp (EXIF retiré,
 * orientation appliquée) et garde-fous du schéma de sortie structurée.
 */
describe('Contenu des photos IA — octets magiques et assainissement', () => {
  it('détecte JPEG, PNG, WebP et HEIC sur leurs octets', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#333333' },
    })
      .jpeg()
      .toBuffer();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#333333' } })
      .png()
      .toBuffer();
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#333333' },
    })
      .webp()
      .toBuffer();
    // Boîte ISO-BMFF « ftyp » avec marque majeure heic (début d'un vrai HEIC).
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(16, 0),
    ]);

    expect(detectImageType(jpeg)).toBe('image/jpeg');
    expect(detectImageType(png)).toBe('image/png');
    expect(detectImageType(webp)).toBe('image/webp');
    expect(detectImageType(heic)).toBe('image/heic');
  });

  it('rejette exécutables, PDF, GIF, SVG et contenus tronqués', () => {
    expect(detectImageType(makeExe())).toBeNull(); // MZ (PE Windows)
    expect(detectImageType(Buffer.from('%PDF-1.7 aaaaaaaa', 'latin1'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a aaaaaaaaaa', 'latin1'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg xmlns="…">aaaa</svg>', 'latin1'))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull(); // trop court
    // RIFF sans WEBP (fichier WAV) refusé aussi.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'latin1'),
    ]);
    expect(detectImageType(wav)).toBeNull();
  });

  it('l’assainissement retire l’EXIF (GPS) et ré-encode en JPEG', async () => {
    const withGps = await makeJpeg({ gps: true });
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const sanitized = await sanitizeImage(withGps);
    const metadata = await sharp(sanitized.data).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined();
    expect(sanitized.width).toBe(640);
    expect(sanitized.height).toBe(480);
  });

  it('réduit les très grandes photos (grand côté ≤ 2048 px) sans agrandir les petites', async () => {
    const large = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: '#888888' },
    })
      .jpeg()
      .toBuffer();
    const resized = await sanitizeImage(large);
    expect(Math.max(resized.width, resized.height)).toBeLessThanOrEqual(2048);

    const small = await sanitizeImage(await makeJpeg());
    expect(small.width).toBe(640); // jamais agrandie
  });

  it('lève ImageDecodeError sur un contenu indécodable (HEIC sans décodeur, corruption)', async () => {
    const fakeHeic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(64, 7),
    ]);
    await expect(sanitizeImage(fakeHeic)).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it('borne la politique de taille à 10 Mo', () => {
    expect(MAX_AI_PHOTO_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('Sortie structurée des fournisseurs — garde-fous', () => {
  const valid = {
    manufacturer: { value: 'Lennox', confidence: 0.9 },
    modelNumber: { value: 'G61MPV', confidence: 0.85 },
    dimensions: { widthIn: 16, heightIn: 25, depthIn: 1, confidence: 0.95 },
    merv: { value: 11, confidence: 0.9 },
    readableText: '16x25x1 MERV 11',
    suggestedMode: null,
    overallConfidence: 0.92,
    notes: null,
  };

  it('valide une sortie conforme', () => {
    const extraction = parseVisionExtraction(structuredClone(valid));
    expect(extraction.modelNumber.value).toBe('G61MPV');
  });

  it('borne les confiances hors [0, 1] au lieu d’échouer', () => {
    const raw = structuredClone(valid);
    raw.overallConfidence = 1.4;
    raw.merv.confidence = -0.2;
    const extraction = parseVisionExtraction(raw);
    expect(extraction.overallConfidence).toBe(1);
    expect(extraction.merv.confidence).toBe(0);
  });

  it('normalise les chaînes vides en null', () => {
    const raw = structuredClone(valid);
    raw.manufacturer.value = '   ';
    const extraction = parseVisionExtraction(raw);
    expect(extraction.manufacturer.value).toBeNull();
  });

  it('rejette une forme inexploitable (vraie erreur de fournisseur)', () => {
    expect(() => parseVisionExtraction({ n_importe: 'quoi' })).toThrow();
    expect(() => parseVisionExtraction('pas un objet')).toThrow();
  });
});
