/**
 * Pipeline images — tâche 08 §4 : téléchargement depuis BigCommerce,
 * ré-encodage WebP (+ conservation de l'original), envoi vers le bucket S3
 * `product-images`. `url` de `ProductImage` reçoit la clé S3 WebP (canonique,
 * servie via CDN).
 *
 * `ImageStore` est une interface injectable : `S3ImageStore` pour l'exécution
 * réelle, `InMemoryImageStore` pour les tests (aucun réseau, pas de `sharp`).
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import type { FetchLike } from './client';

export interface StoredImage {
  /** Clé S3 canonique (variante WebP) — à écrire dans `ProductImage.url`. */
  key: string;
  width: number;
  height: number;
}

export interface ImageStore {
  store(sourceUrl: string, keyBase: string): Promise<StoredImage>;
}

export interface S3ImageStoreOptions {
  bucket: string;
  keyPrefix?: string;
  region?: string;
  client?: S3Client;
  fetchImpl?: FetchLike;
}

function extensionOf(url: string, contentType: string | null): string {
  const fromUrl = url.split('?')[0]?.split('.').pop();
  if (fromUrl && /^[a-z0-9]{2,4}$/i.test(fromUrl)) return fromUrl.toLowerCase();
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('gif')) return 'gif';
  return 'jpg';
}

export class S3ImageStore implements ImageStore {
  private readonly client: S3Client;
  private readonly fetchImpl: FetchLike;
  private readonly keyPrefix: string;

  constructor(private readonly options: S3ImageStoreOptions) {
    this.client = options.client ?? new S3Client({ region: options.region ?? 'ca-central-1' });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.keyPrefix = options.keyPrefix ?? 'product-images';
  }

  async store(sourceUrl: string, keyBase: string): Promise<StoredImage> {
    const response = await this.fetchImpl(sourceUrl);
    if (!response.ok) {
      throw new Error(`Téléchargement image échoué (${response.status}) : ${sourceUrl}`);
    }
    const original = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type');
    const extension = extensionOf(sourceUrl, contentType);

    const image = sharp(original);
    const metadata = await image.metadata();
    const webp = await image.webp({ quality: 82 }).toBuffer();

    const webpKey = `${this.keyPrefix}/${keyBase}.webp`;
    const originalKey = `${this.keyPrefix}/${keyBase}.original.${extension}`;

    await Promise.all([
      this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: webpKey,
          Body: webp,
          ContentType: 'image/webp',
        }),
      ),
      this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: originalKey,
          Body: original,
          ContentType: contentType ?? undefined,
        }),
      ),
    ]);

    return { key: webpKey, width: metadata.width ?? 0, height: metadata.height ?? 0 };
  }
}

/** Fausse implémentation pour les tests et le `--dry-run` : aucun réseau. */
export class InMemoryImageStore implements ImageStore {
  readonly stored: Array<{ sourceUrl: string; key: string }> = [];

  async store(sourceUrl: string, keyBase: string): Promise<StoredImage> {
    const key = `product-images/${keyBase}.webp`;
    this.stored.push({ sourceUrl, key });
    return { key, width: 800, height: 800 };
  }
}
