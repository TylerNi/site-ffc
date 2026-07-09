import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../../config/env';

/**
 * Jeton signé de téléchargement de facture (tâche 12) — permet un lien de
 * facture DANS un courriel qui fonctionne sans session (invités inclus),
 * sans exposer le bucket S3. Le jeton porte l'id de facture et une
 * expiration, signés en HMAC-SHA256 : impossible à forger, impossible de
 * viser une autre facture.
 *
 * Format : base64url(invoiceId.expEpoch) + "." + base64url(hmac). Le corps
 * ne contient aucune donnée sensible (un id de facture opaque).
 */
@Injectable()
export class InvoiceDownloadTokenService {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    // Réutilise le secret JWT (rotation gérée au même endroit). Domaine
    // distinct grâce au préfixe ci-dessous : un jeton d'accès ne peut pas
    // servir de jeton de facture et vice-versa.
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.ttlSeconds = config.get('INVOICE_DOWNLOAD_TTL_HOURS', { infer: true }) * 3600;
  }

  sign(invoiceId: string, now: Date = new Date()): string {
    const exp = Math.floor(now.getTime() / 1000) + this.ttlSeconds;
    const body = `${invoiceId}.${exp}`;
    const payload = b64url(Buffer.from(body, 'utf8'));
    return `${payload}.${this.mac(body)}`;
  }

  /** Retourne l'id de facture si le jeton est valide et non expiré, sinon null. */
  verify(token: string, now: Date = new Date()): string | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    let body: string;
    try {
      body = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return null;
    }

    const expected = this.mac(body);
    if (!safeEqual(signature, expected)) return null;

    const sep = body.lastIndexOf('.');
    if (sep <= 0) return null;
    const invoiceId = body.slice(0, sep);
    const exp = Number(body.slice(sep + 1));
    if (!Number.isFinite(exp) || exp * 1000 < now.getTime()) return null;
    return invoiceId;
  }

  private mac(body: string): string {
    return b64url(createHmac('sha256', `invoice-download:${this.secret}`).update(body).digest());
  }
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
