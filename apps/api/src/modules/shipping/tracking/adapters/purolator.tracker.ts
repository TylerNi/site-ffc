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
import { purolatorStatusFor } from './purolator-codes';
import { isRetryableHttpStatus } from './canada-post.tracker';

/**
 * Adapter Purolator — E-Ship Web Services, *TrackingService* SOAP
 * (`TrackPackagesByPin`, authentification Basic clé/mot de passe).
 *
 * L'accès API dépend de la checklist tâche 01 (« selon l'accès disponible ») :
 * sans clés, l'adapter est non configuré — le poller reporte sans compter
 * d'échec et le client garde le lien de repérage public (tâche 13).
 *
 * Particularités enfermées ici : l'enveloppe SOAP v1, les `ScanType`
 * (purolator-codes.ts), les horodatages locaux « ScanDate + ScanTime » sans
 * fuseau (heure de l'Est, voir tracking-time.ts) et le repérage « PIN
 * inconnu » (normal dans les premières heures).
 */
@Injectable()
export class PurolatorTracker implements CarrierTracker {
  readonly carrier = 'PUROLATOR' as const;

  private readonly logger = new Logger(PurolatorTracker.name);
  private readonly baseUrl: string;
  private readonly authorization: string | null;
  private readonly parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    removeNSPrefix: true,
  });

  constructor(
    private readonly http: TrackingHttp,
    config: ConfigService<Env, true>,
  ) {
    this.baseUrl = config.get('PUROLATOR_BASE_URL', { infer: true }).replace(/\/$/, '');
    const key = config.get('PUROLATOR_API_KEY', { infer: true });
    const password = config.get('PUROLATOR_API_PASSWORD', { infer: true });
    this.authorization =
      key && password
        ? `Basic ${Buffer.from(`${key}:${password}`, 'utf8').toString('base64')}`
        : null;
  }

  isConfigured(): boolean {
    return this.authorization !== null;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.authorization) {
      throw new CarrierTrackingError('Purolator non configuré.', this.carrier, null, false);
    }

    const response = await this.http.request({
      carrier: this.carrier,
      method: 'POST',
      url: `${this.baseUrl}/EWS/V1/Tracking/TrackingService.asmx`,
      headers: {
        authorization: this.authorization,
        'content-type': 'text/xml; charset=utf-8',
        soapaction: 'http://purolator.com/pws/service/v1/TrackPackagesByPin',
      },
      body: this.envelope(trackingNumber.trim()),
    });

    if (response.status !== 200) {
      throw new CarrierTrackingError(
        `Purolator → ${response.status} : ${response.body.slice(0, 300)}`,
        this.carrier,
        response.status,
        isRetryableHttpStatus(response.status),
      );
    }
    return this.parseResponse(response.body);
  }

  /* ------------------------------- Requête ------------------------------- */

  private envelope(pin: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:v1="http://purolator.com/pws/datatypes/v1">
  <soapenv:Header>
    <v1:RequestContext>
      <v1:Version>1.2</v1:Version>
      <v1:Language>fr</v1:Language>
      <v1:GroupID>ffc</v1:GroupID>
      <v1:RequestReference>suivi-colis</v1:RequestReference>
    </v1:RequestContext>
  </soapenv:Header>
  <soapenv:Body>
    <v1:TrackPackagesByPinRequest>
      <v1:PINs>
        <v1:PIN>
          <v1:Value>${escapeXml(pin)}</v1:Value>
        </v1:PIN>
      </v1:PINs>
    </v1:TrackPackagesByPinRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /* ------------------------------- Parsing ------------------------------- */

  private parseResponse(xml: string): TrackingResult {
    let root: Record<string, unknown>;
    try {
      root = this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`XML Purolator illisible : ${String(error)}`);
      throw new CarrierTrackingError('XML Purolator illisible.', this.carrier, 200, false);
    }

    const info = dig(root, [
      'Envelope',
      'Body',
      'TrackPackagesByPinResponse',
      'TrackingInformationList',
      'TrackingInformation',
    ]);
    // Aucune information de repérage : PIN encore inconnu du réseau.
    if (!info) return TRACKING_NOT_FOUND;

    const infos = asArray(info);
    const first = infos[0] as Record<string, unknown> | undefined;
    if (!first) return TRACKING_NOT_FOUND;

    const scans = asArray(dig(first, ['Scans', 'Scan']));
    const events: TrackingEvent[] = [];
    for (const raw of scans) {
      if (!raw || typeof raw !== 'object') continue;
      const scan = raw as Record<string, unknown>;
      const scanType = text(scan['ScanType']);
      const occurredAt = zonedToUtc(
        text(scan['ScanDate']) ?? '',
        text(scan['ScanTime'])?.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1:$2:$3') ?? '',
      );
      if (!scanType || !occurredAt) continue;

      const depot = scan['Depot'] as Record<string, unknown> | undefined;
      events.push({
        code: scanType,
        status: purolatorStatusFor(scanType),
        description: text(scan['Description']),
        location: text(depot?.['Name']),
        occurredAt,
      });
    }

    // « PIN inconnu » se manifeste aussi par une liste de scans vide.
    if (events.length === 0 && scans.length === 0) return TRACKING_NOT_FOUND;

    return { kind: 'ok', events, estimatedDeliveryAt: null };
  }
}

function dig(root: unknown, path: string[]): unknown {
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
