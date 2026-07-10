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
import { dateOnlyToUtcNoon, zonedToUtc } from '../tracking-time';
import { CANADA_POST_NOT_FOUND_CODES, canadaPostStatusFor } from './canada-post-codes';

/**
 * Adapter Postes Canada — service REST *Get Tracking Details* du programme
 * développeur (`GET /vis/track/pin/{pin}/detail`, XML v2, authentification
 * Basic avec la clé API du compte).
 *
 * Particularités enfermées ici : le XML `tracking-detail`, les
 * « significant events » (code numérique + date + heure + abréviation de
 * fuseau), la date de livraison prévue, et les erreurs métier
 * (<messages><message><code>004/016</code> = numéro inconnu — normal dans
 * les premières heures d'une étiquette).
 */
@Injectable()
export class CanadaPostTracker implements CarrierTracker {
  readonly carrier = 'CANADA_POST' as const;

  private readonly logger = new Logger(CanadaPostTracker.name);
  private readonly baseUrl: string;
  private readonly authorization: string | null;
  private readonly parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

  constructor(
    private readonly http: TrackingHttp,
    config: ConfigService<Env, true>,
  ) {
    this.baseUrl = config.get('CANADA_POST_BASE_URL', { infer: true }).replace(/\/$/, '');
    const username = config.get('CANADA_POST_API_USERNAME', { infer: true });
    const password = config.get('CANADA_POST_API_PASSWORD', { infer: true });
    this.authorization =
      username && password
        ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
        : null;
  }

  isConfigured(): boolean {
    return this.authorization !== null;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.authorization) {
      throw new CarrierTrackingError('Postes Canada non configuré.', this.carrier, null, false);
    }

    const pin = encodeURIComponent(trackingNumber.trim());
    const response = await this.http.request({
      carrier: this.carrier,
      method: 'GET',
      url: `${this.baseUrl}/vis/track/pin/${pin}/detail`,
      headers: {
        authorization: this.authorization,
        accept: 'application/vnd.cpc.track-v2+xml',
        'accept-language': 'fr-CA',
      },
    });

    if (response.status === 404 || this.isNotFoundMessage(response.body)) {
      return TRACKING_NOT_FOUND;
    }
    if (response.status !== 200) {
      throw new CarrierTrackingError(
        `Postes Canada → ${response.status} : ${response.body.slice(0, 300)}`,
        this.carrier,
        response.status,
        isRetryableHttpStatus(response.status),
      );
    }

    return this.parseDetail(response.body);
  }

  /* ------------------------------- Parsing ------------------------------- */

  private parseDetail(xml: string): TrackingResult {
    const root = this.parseXml(xml);
    const detail = root['tracking-detail'];
    if (!detail || typeof detail !== 'object') {
      throw new CarrierTrackingError(
        'Réponse Postes Canada sans <tracking-detail>.',
        this.carrier,
        200,
        false,
      );
    }

    const doc = detail as Record<string, unknown>;
    const occurrences = asArray(
      (doc['significant-events'] as Record<string, unknown> | undefined)?.['occurrence'],
    );

    const events: TrackingEvent[] = [];
    for (const raw of occurrences) {
      if (!raw || typeof raw !== 'object') continue;
      const occurrence = raw as Record<string, unknown>;
      const code = text(occurrence['event-identifier']);
      const occurredAt = zonedToUtc(
        text(occurrence['event-date']) ?? '',
        text(occurrence['event-time']) ?? '',
        text(occurrence['event-time-zone']),
      );
      if (!code || !occurredAt) continue; // occurrence malformée : ignorée, jamais bloquante

      const site = text(occurrence['event-site']);
      const province = text(occurrence['event-province']);
      events.push({
        code,
        status: canadaPostStatusFor(code),
        description: text(occurrence['event-description']),
        location: site ? (province ? `${site}, ${province}` : site) : (province ?? null),
        occurredAt,
      });
    }

    return {
      kind: 'ok',
      events,
      estimatedDeliveryAt:
        dateOnlyToUtcNoon(text(doc['expected-delivery-date'])) ??
        dateOnlyToUtcNoon(text(doc['changed-expected-date'])),
    };
  }

  /** <messages><message><code>004</code>… = « No Pin History » (numéro inconnu). */
  private isNotFoundMessage(body: string): boolean {
    if (!body.includes('<message')) return false;
    try {
      const root = this.parseXml(body);
      const messages = asArray(
        (root['messages'] as Record<string, unknown> | undefined)?.['message'],
      );
      return messages.some(
        (message) =>
          message &&
          typeof message === 'object' &&
          CANADA_POST_NOT_FOUND_CODES.has(text((message as Record<string, unknown>)['code']) ?? ''),
      );
    } catch {
      return false;
    }
  }

  private parseXml(xml: string): Record<string, unknown> {
    try {
      return this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`XML Postes Canada illisible : ${String(error)}`);
      throw new CarrierTrackingError('XML Postes Canada illisible.', this.carrier, 200, false);
    }
  }
}

/** 5xx, 429 et 408 méritent une retentative ; le reste est définitif. */
export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : String(value as string | number);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
