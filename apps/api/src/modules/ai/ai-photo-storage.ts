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
 * Stockage des photos client du pipeline IA (tâche 17) — bucket S3 PRIVÉ
 * `ai-photos` (cycle de vie de suppression à 30 jours en filet, la purge
 * applicative reste la source de vérité — Loi 25). Mémoire en dev/test.
 *
 * Téléversement DIRECT client → S3 par URL présignée. Le brief demande une
 * « taille max 10 Mo imposée par la politique » : seule une politique POST
 * (`createPresignedPost` + condition `content-length-range`) sait borner la
 * taille côté S3 — un PUT présigné simple ne le peut pas (même constat que
 * `product-image-storage.ts`, tâche 10). On émet donc un POST présigné.
 * Défense en profondeur : l'API revalide TOUT à la soumission (taille,
 * octets magiques, ré-encodage sharp sans EXIF) — voir `image-content.ts`.
 *
 * Clés non devinables : `ai/<userId>/<uuid>` (préfixe par propriétaire,
 * UUID aléatoire). L'objet n'est JAMAIS public ; personne d'autre que l'API
 * ne le relit.
 */
export const AI_PHOTO_STORAGE = Symbol('AI_PHOTO_STORAGE');

/** Taille maximale acceptée pour une photo (imposée par la politique S3 ET revérifiée par l'API). */
export const MAX_AI_PHOTO_BYTES = 10 * 1024 * 1024;

/** Durée de vie courte de l'URL présignée (secondes). */
export const AI_UPLOAD_EXPIRES_SECONDS = 300;

const KEY_PREFIX = 'ai';

export interface PresignedAiPhotoUpload {
  /** Clé S3 de l'objet — persistée dans `ai_identifications.image_key`. */
  key: string;
  /** URL cible du POST multipart (S3 réel, ou relais dev local). */
  url: string;
  /** Champs à joindre au formulaire multipart, avant le fichier. */
  fields: Record<string, string>;
  maxBytes: number;
  expiresInSeconds: number;
}

export interface AiPhotoStorage {
  presignUpload(userId: string): Promise<PresignedAiPhotoUpload>;
  /** Relit l'objet téléversé (validation serveur à la soumission). */
  fetch(key: string): Promise<Buffer | null>;
  /** Remplace l'objet par l'image assainie (ré-encodée sans EXIF). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Supprime l'objet (purge Loi 25). Idempotent. */
  delete(key: string): Promise<void>;
}

export function newAiPhotoKey(userId: string): string {
  return `${KEY_PREFIX}/${userId}/${randomUUID()}`;
}

@Injectable()
export class S3AiPhotoStorage implements AiPhotoStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({ region });
  }

  async presignUpload(userId: string): Promise<PresignedAiPhotoUpload> {
    const key = newAiPhotoKey(userId);
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        // Taille bornée par S3 lui-même — le cœur de la « politique ».
        ['content-length-range', 1, MAX_AI_PHOTO_BYTES],
        // Filtre grossier ; le vrai contrôle (octets magiques) est à la soumission.
        ['starts-with', '$Content-Type', 'image/'],
      ],
      Expires: AI_UPLOAD_EXPIRES_SECONDS,
    });
    return {
      key,
      url,
      fields,
      maxBytes: MAX_AI_PHOTO_BYTES,
      expiresInSeconds: AI_UPLOAD_EXPIRES_SECONDS,
    };
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

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Défense en profondeur : chiffrement au repos côté serveur.
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/**
 * Stockage mémoire — dev sans bucket, et tests (aucun réseau). L'URL
 * présignée pointe vers le relais local `POST /v1/ai/dev-uploads`
 * (`ai-dev-upload.controller.ts`), jamais actif quand un vrai bucket est
 * configuré — même mécanique que le relais des images produit (tâche 10).
 */
@Injectable()
export class InMemoryAiPhotoStorage implements AiPhotoStorage {
  private readonly store = new Map<string, Buffer>();

  constructor(private readonly publicApiUrl: string) {}

  async presignUpload(userId: string): Promise<PresignedAiPhotoUpload> {
    const key = newAiPhotoKey(userId);
    return {
      key,
      url: `${this.publicApiUrl}/v1/ai/dev-uploads`,
      fields: { key },
      maxBytes: MAX_AI_PHOTO_BYTES,
      expiresInSeconds: AI_UPLOAD_EXPIRES_SECONDS,
    };
  }

  async fetch(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    this.store.set(key, body);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export const aiPhotoStorageProvider = {
  provide: AI_PHOTO_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): AiPhotoStorage => {
    const logger = new Logger('AiPhotoStorage');
    const bucket = config.get('S3_AI_PHOTOS_BUCKET', { infer: true });
    if (bucket) {
      return new S3AiPhotoStorage(bucket, config.get('AWS_REGION', { infer: true }));
    }
    logger.warn('S3_AI_PHOTOS_BUCKET absent — photos IA EN MÉMOIRE (dev/test).');
    return new InMemoryAiPhotoStorage(config.get('PUBLIC_API_URL', { infer: true }));
  },
};
