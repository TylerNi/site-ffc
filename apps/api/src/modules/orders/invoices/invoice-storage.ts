import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../../config/env';

/**
 * Stockage des factures PDF (tâche 12) — bucket S3 PRIVÉ en production,
 * mémoire en dev/test (aucun réseau). Les octets ne sont jamais servis
 * directement depuis S3 : le téléchargement passe TOUJOURS par l'API
 * (endpoint authentifié ou lien signé), qui relit les octets via
 * `fetch(key)`. Le bucket reste donc sans accès public.
 */
export const INVOICE_STORAGE = Symbol('INVOICE_STORAGE');

export interface StoredInvoice {
  /** Clé S3 (ou logique en mémoire) — écrite dans `invoices.pdf_key`. */
  key: string;
}

export interface InvoiceStorage {
  put(key: string, body: Buffer): Promise<StoredInvoice>;
  fetch(key: string): Promise<Buffer | null>;
}

/** Stockage S3 réel (bucket privé `invoices`). */
@Injectable()
export class S3InvoiceStorage implements InvoiceStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(bucket: string, region: string, client?: S3Client) {
    this.bucket = bucket;
    this.client = client ?? new S3Client({ region });
  }

  async put(key: string, body: Buffer): Promise<StoredInvoice> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/pdf',
        // Défense en profondeur : chiffrement au repos côté serveur.
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key };
  }

  async fetch(key: string): Promise<Buffer | null> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  }
}

/** Stockage mémoire — dev sans bucket, et tests (aucun réseau). */
@Injectable()
export class InMemoryInvoiceStorage implements InvoiceStorage {
  private readonly store = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<StoredInvoice> {
    this.store.set(key, body);
    return { key };
  }

  async fetch(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }
}

/**
 * Fournit l'implémentation adaptée à l'environnement : S3 si un bucket est
 * configuré, mémoire sinon (dev/test). En production, l'absence de bucket
 * est refusée au démarrage par la validation d'environnement (env.ts).
 */
export const invoiceStorageProvider = {
  provide: INVOICE_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): InvoiceStorage => {
    const logger = new Logger('InvoiceStorage');
    const bucket = config.get('S3_INVOICES_BUCKET', { infer: true });
    if (bucket) {
      return new S3InvoiceStorage(bucket, config.get('AWS_REGION', { infer: true }));
    }
    logger.warn('S3_INVOICES_BUCKET absent — stockage des factures EN MÉMOIRE (dev/test).');
    return new InMemoryInvoiceStorage();
  },
};
