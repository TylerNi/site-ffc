import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../../../config/env';
import {
  type CarrierTracker,
  CarrierTrackingError,
  TRACKING_NOT_FOUND,
  type TrackingEvent,
  type TrackingResult,
} from '../carrier-tracker';
import { TrackingHttp } from '../tracking-http';
import { dateOnlyToUtcNoon } from '../tracking-time';
import { nationexStatusFor } from './nationex-codes';
import { isRetryableHttpStatus } from './canada-post.tracker';

/** Entrée de repérage telle que renvoyée par l'API v4. */
interface NationexHistoryEntry {
  dateTime?: string;
  status?: string;
  statusDescription?: string;
  city?: string;
  province?: string;
}

interface NationexTrackingResponse {
  trackingNumber?: string;
  expectedDeliveryDate?: string | null;
  trackingHistories?: NationexHistoryEntry[];
}

/**
 * Adapter Nationex — API REST v4 (`GET /api/v4/Shipments/{n°}/tracking`,
 * JSON, authentification Basic « numéro de client : clé API »).
 *
 * Particularités enfermées ici : le JSON `trackingHistories` (horodatages
 * ISO AVEC décalage — merci Nationex), les codes courts de statut
 * (nationex-codes.ts) et le 404 « expédition inconnue » des premières
 * heures.
 */
@Injectable()
export class NationexTracker implements CarrierTracker {
  readonly carrier = 'NATIONEX' as const;

  private readonly baseUrl: string;
  private readonly authorization: string | null;

  constructor(
    private readonly http: TrackingHttp,
    config: ConfigService<Env, true>,
  ) {
    this.baseUrl = config.get('NATIONEX_BASE_URL', { infer: true }).replace(/\/$/, '');
    const customerId = config.get('NATIONEX_CUSTOMER_ID', { infer: true });
    const apiKey = config.get('NATIONEX_API_KEY', { infer: true });
    this.authorization =
      customerId && apiKey
        ? `Basic ${Buffer.from(`${customerId}:${apiKey}`, 'utf8').toString('base64')}`
        : null;
  }

  isConfigured(): boolean {
    return this.authorization !== null;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.authorization) {
      throw new CarrierTrackingError('Nationex non configuré.', this.carrier, null, false);
    }

    const response = await this.http.request({
      carrier: this.carrier,
      method: 'GET',
      url: `${this.baseUrl}/api/v4/Shipments/${encodeURIComponent(trackingNumber.trim())}/tracking`,
      headers: { authorization: this.authorization, accept: 'application/json' },
    });

    if (response.status === 404) return TRACKING_NOT_FOUND;
    if (response.status !== 200) {
      throw new CarrierTrackingError(
        `Nationex → ${response.status} : ${response.body.slice(0, 300)}`,
        this.carrier,
        response.status,
        isRetryableHttpStatus(response.status),
      );
    }

    let payload: NationexTrackingResponse;
    try {
      payload = JSON.parse(response.body) as NationexTrackingResponse;
    } catch {
      throw new CarrierTrackingError('JSON Nationex illisible.', this.carrier, 200, false);
    }

    const events: TrackingEvent[] = [];
    for (const entry of payload.trackingHistories ?? []) {
      const code = entry.status?.trim();
      const occurredAt = entry.dateTime ? new Date(entry.dateTime) : null;
      if (!code || !occurredAt || Number.isNaN(occurredAt.getTime())) continue;
      events.push({
        code,
        status: nationexStatusFor(code),
        description: entry.statusDescription?.trim() || null,
        location: joinLocation(entry.city, entry.province),
        occurredAt,
      });
    }

    return {
      kind: 'ok',
      events,
      estimatedDeliveryAt: dateOnlyToUtcNoon(payload.expectedDeliveryDate),
    };
  }
}

function joinLocation(city?: string, province?: string): string | null {
  const cleanCity = city?.trim();
  const cleanProvince = province?.trim();
  if (cleanCity && cleanProvince) return `${cleanCity}, ${cleanProvince}`;
  return cleanCity || cleanProvince || null;
}
