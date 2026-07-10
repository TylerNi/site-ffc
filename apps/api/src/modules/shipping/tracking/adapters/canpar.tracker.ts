import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XMLParser } from 'fast-xml-parser';
import { type Env } from '../../../../config/env';
import {
  type CarrierTracker,
  CarrierTrackingError,
  TRACKING_NOT_FOUND,
  type TrackingEvent,
  type TrackingResult,
} from '../carrier-tracker';
import { TrackingHttp } from '../tracking-http';
import { zonedToUtc } from '../tracking-time';
import { canparStatusFor } from './canpar-codes';
import { isRetryableHttpStatus } from './canada-post.tracker';

/**
 * Adapter Canpar — service web CanShip (`trackByBarcodeV2`, enveloppe SOAP,
 * authentification utilisateur/mot de passe DANS le corps de la requête).
 *
 * Particularités enfermées ici : l'enveloppe SOAP (préfixes de namespaces
 * variables — le parseur les retire), les horodatages locaux
 * « yyyyMMdd HHmmss » SANS fuseau (interprétés en heure de l'Est, voir
 * tracking-time.ts), les codes de trois lettres (canpar-codes.ts) et
 * l'erreur métier « NO SHIPMENT FOUND » (numéro inconnu, normal au début).
 */
@Injectable()
export class CanparTracker implements CarrierTracker {
  readonly carrier = 'CANPAR' as const;

  private readonly logger = new Logger(CanparTracker.name);
  private readonly baseUrl: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    removeNSPrefix: true,
  });

  constructor(
    private readonly http: TrackingHttp,
    config: ConfigService<Env, true>,
  ) {
    this.baseUrl = config.get('CANPAR_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.username = config.get('CANPAR_API_USERNAME', { infer: true });
    this.password = config.get('CANPAR_API_PASSWORD', { infer: true });
  }

  isConfigured(): boolean {
    return Boolean(this.username && this.password);
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.isConfigured()) {
      throw new CarrierTrackingError('Canpar non configuré.', this.carrier, null, false);
    }

    const response = await this.http.request({
      carrier: this.carrier,
      method: 'POST',
      url: `${this.baseUrl}/canshipws/services/CanparAddonsService`,
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' },
      body: this.envelope(trackingNumber.trim()),
    });

    if (response.status !== 200) {
      throw new CarrierTrackingError(
        `Canpar → ${response.status} : ${response.body.slice(0, 300)}`,
        this.carrier,
        response.status,
        isRetryableHttpStatus(response.status),
      );
    }
    return this.parseResponse(response.body);
  }

  /* ------------------------------- Requête ------------------------------- */

  private envelope(barcode: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ws="http://ws.business.canshipws.canpar.com"
                  xmlns:xsd="http://ws.dto.canshipws.canpar.com/xsd">
  <soapenv:Body>
    <ws:trackByBarcodeV2>
      <ws:request>
        <xsd:user_id>${escapeXml(this.username ?? '')}</xsd:user_id>
        <xsd:password>${escapeXml(this.password ?? '')}</xsd:password>
        <xsd:barcode>${escapeXml(barcode)}</xsd:barcode>
        <xsd:track_shipment>true</xsd:track_shipment>
      </ws:request>
    </ws:trackByBarcodeV2>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /* ------------------------------- Parsing ------------------------------- */

  private parseResponse(xml: string): TrackingResult {
    let root: Record<string, unknown>;
    try {
      root = this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`XML Canpar illisible : ${String(error)}`);
      throw new CarrierTrackingError('XML Canpar illisible.', this.carrier, 200, false);
    }

    const returned = dig(root, ['Envelope', 'Body', 'trackByBarcodeV2Response', 'return']);
    if (!returned || typeof returned !== 'object') {
      throw new CarrierTrackingError(
        'Réponse Canpar sans <return> (trackByBarcodeV2).',
        this.carrier,
        200,
        false,
      );
    }
    const body = returned as Record<string, unknown>;

    // <error> non vide = erreur métier. « NO SHIPMENT FOUND » = numéro inconnu.
    const error = text(body['error']);
    if (error) {
      if (/no shipment|not found/i.test(error)) return TRACKING_NOT_FOUND;
      throw new CarrierTrackingError(`Canpar : ${error}`, this.carrier, 200, false);
    }

    const result = body['result'] as Record<string, unknown> | undefined;
    if (!result) return TRACKING_NOT_FOUND;

    const events: TrackingEvent[] = [];
    for (const raw of asArray(result['events'])) {
      if (!raw || typeof raw !== 'object') continue;
      const event = raw as Record<string, unknown>;
      const code = text(event['code']);
      const occurredAt = parseCanparLocalDateTime(text(event['local_date_time']));
      if (!code || !occurredAt) continue;

      const address = event['address'] as Record<string, unknown> | undefined;
      const city = text(address?.['city']);
      const province = text(address?.['province']);
      events.push({
        code,
        status: canparStatusFor(code),
        description: text(event['description']),
        location: city ? (province ? `${city}, ${province}` : city) : (province ?? null),
        occurredAt,
      });
    }

    return {
      kind: 'ok',
      events,
      estimatedDeliveryAt: parseCanparLocalDateTime(text(result['estimated_delivery_date'])),
    };
  }
}

/** « 20260714 162311 » (heure locale Canpar) → Date UTC (heure de l'Est). */
export function parseCanparLocalDateTime(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds] = match;
  return zonedToUtc(`${year}-${month}-${day}`, `${hours}:${minutes}:${seconds}`);
}

function dig(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value == null || typeof value === 'object') return null;
  const trimmed = String(value as string | number).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
