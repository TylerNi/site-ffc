import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { type Env } from '../../config/env';

/**
 * Stockage des images produit (tâche 10) — MÊME bucket S3 public/CDN que
 * l'import BigCommerce (tâche 08, `S3_BUCKET_PRODUCT_IMAGES`), MÊME
 * préfixe de clé (`product-images/`) : les deux pipelines cohabitent sans
 * collision. Bucket public, contrairement au bucket privé des factures
 * (`invoice-storage.ts`) — la clé écrite dans `ProductImage.url` est servie
 * telle quelle par le CDN côté vitrine (`apps/web/src/lib/images.ts`).
 *
 * Téléversement DIRECT navigateur → S3 par URL présignée (POST) : l'API
 * n'encaisse jamais les octets à l'aller. `Conditions` fait respecter type
 * ET taille par S3 lui-même (un PUT présigné simple ne peut pas borner la
 * taille). Au retour (« enregistrer l'image »), l'API relit l'objet pour
 * valider que c'est une vraie image et en extraire les dimensions (sharp).
 */
export const PRODUCT_IMAGE_STORAGE = Symbol('PRODUCT_IMAGE_STORAGE');

export const ALLOWED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageContentType = (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];

/** 8 Mo — largement suffisant pour une photo produit, borné côté S3. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const KEY_PREFIX = 'product-images';

const EXTENSION_BY_CONTENT_TYPE: Record<AllowedImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface PresignedImageUpload {
  /** Clé S3 à écrire ensuite dans `ProductImage.url` une fois l'image enregistrée. */
  key: string;
  /** URL cible du POST (le formulaire multipart, pas du JSON). */
  url: string;
  /** Champs à joindre au formulaire multipart, dans l'ordre, avant le fichier. */
  fields: Record<string, string>;
}

export interface ProductImageStorage {
  presignUpload(params: {
    productId: string;
    contentType: AllowedImageContentType;
  }): Promise<PresignedImageUpload>;
  /** Relit l'objet téléversé (validation + dimensions côté serveur). */
  fetch(key: string): Promise<Buffer | null>;
  /** Écriture directe — utilisée par les tests pour simuler le PUT du navigateur. */
  put(key: string, body: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
}

function newKey(productId: string, contentType: AllowedImageContentType): string {
  return `${KEY_PREFIX}/${productId}/${randomUUID()}.${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}

@Injectable()
export class S3ProductImageStorage implements ProductImageStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({ region });
  }

  async presignUpload(params: {
    productId: string;
    contentType: AllowedImageContentType;
  }): Promise<PresignedImageUpload> {
    const key = newKey(params.productId, params.contentType);
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, MAX_IMAGE_BYTES],
        ['eq', '$Content-Type', params.contentType],
      ],
      Fields: { 'Content-Type': params.contentType },
      Expires: 300,
    });
    return { key, url, fields };
  }

  async fetch(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch {
      return null;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/**
 * Stockage mémoire — dev sans bucket, et tests (aucun réseau). L'URL
 * présignée pointe vers le relais `POST /v1/dev/uploads`
 * (`dev-upload.controller.ts`) plutôt que vers AWS : sans ce relais, le
 * navigateur ne pourrait pas « téléverser » quoi que ce soit en local
 * (« memory:// » n'est pas une URL joignable). Le relais refuse tout appel
 * si un vrai bucket est configuré — jamais actif en production.
 */
@Injectable()
export class InMemoryProductImageStorage implements ProductImageStorage {
  private readonly store = new Map<string, Buffer>();

  constructor(private readonly publicApiUrl: string) {}

  async presignUpload(params: {
    productId: string;
    contentType: AllowedImageContentType;
  }): Promise<PresignedImageUpload> {
    const key = newKey(params.productId, params.contentType);
    return { key, url: `${this.publicApiUrl}/v1/dev/uploads`, fields: { key } };
  }

  async fetch(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.store.set(key, body);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export const productImageStorageProvider = {
  provide: PRODUCT_IMAGE_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): ProductImageStorage => {
    const logger = new Logger('ProductImageStorage');
    const bucket = config.get('S3_BUCKET_PRODUCT_IMAGES', { infer: true });
    if (bucket) {
      return new S3ProductImageStorage(bucket, config.get('AWS_REGION', { infer: true }));
    }
    logger.warn('S3_BUCKET_PRODUCT_IMAGES absent — images produit EN MÉMOIRE (dev/test).');
    return new InMemoryProductImageStorage(config.get('PUBLIC_API_URL', { infer: true }));
  },
};
