import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Locale } from '@ffc/core';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { type PushTemplateKey, renderPush } from './push-templates';

/** Point d'envoi Expo Push (constante : jamais dépendant d'une entrée). */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface SendPushParams {
  /** Compte destinataire — sans compte (commande invitée), rien à pousser. */
  userId: string | null;
  locale: Locale;
  templateKey: PushTemplateKey;
  variables: Record<string, string>;
  /** Données jointes pour la navigation dans l'app (tâche 19). */
  data?: Record<string, string>;
  /**
   * Clé d'idempotence (`notifications.idempotency_key`) : un jalon rejoué
   * (polling qui revoit l'événement) ne pousse JAMAIS deux fois.
   */
  idempotencyKey: string;
  /** Contexte de commande (trace). */
  orderId?: string | null;
}

/** Notification capturée par le driver `log` — consommée par les tests. */
export interface PushOutboxEntry {
  userId: string;
  tokens: string[];
  templateKey: PushTemplateKey;
  title: string;
  body: string;
  locale: Locale;
  data?: Record<string, string>;
}

/** Ticket de réception Expo. */
interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Notifications push Expo (tâche 14), envoyées aux appareils enregistrés
 * (`user_devices`, alimentée par l'app mobile — tâche 19).
 *
 * Règles :
 *   - **préférences** : catégorie × canal (notification_preferences). Sans
 *     ligne, le TRANSACTIONNEL est actif par défaut ; une désactivation
 *     explicite est respectée (trace SKIPPED).
 *   - **anti-doublon strict** : l'unicité de `notifications.idempotency_key`
 *     porte la garantie « un jalon = une notification », quel que soit le
 *     nombre de rejeux du polling.
 *   - **meilleur effort** : l'envoi réel est best effort (trace FAILED sans
 *     retentative) — le courriel du même jalon reste le canal fiable.
 *   - un jeton rejeté « DeviceNotRegistered » supprime l'appareil (l'app a
 *     été désinstallée) : auto-réparation du carnet d'appareils.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly driver: Env['PUSH_DRIVER'];
  private readonly expoAccessToken: string | undefined;

  /** Boîte d'envoi mémoire du driver `log` (assertions de test). */
  readonly outbox: PushOutboxEntry[] = [];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.driver = config.get('PUSH_DRIVER', { infer: true });
    this.expoAccessToken = config.get('EXPO_ACCESS_TOKEN', { infer: true });
  }

  async send(params: SendPushParams): Promise<void> {
    if (!params.userId) return; // commande invitée : aucun appareil possible

    // Idempotence : la clé a déjà été consommée (envoyée, sautée ou échouée)
    // → le jalon est réputé traité, on ne rejoue rien.
    const existing = await this.prisma.notification.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      select: { id: true },
    });
    if (existing) return;

    const rendered = renderPush(params.templateKey, params.locale, params.variables);

    // Préférence explicite (catégorie TRANSACTIONAL × canal PUSH). Sans
    // ligne : actif par défaut (LCAP : transactionnel pur).
    const preference = await this.prisma.notificationPreference.findUnique({
      where: {
        userId_category_channel: {
          userId: params.userId,
          category: 'TRANSACTIONAL',
          channel: 'PUSH',
        },
      },
      select: { enabled: true },
    });
    if (preference?.enabled === false) {
      await this.trace(params, rendered.title, 'SKIPPED', null, null, 'Préférence désactivée');
      return;
    }

    const devices = await this.prisma.userDevice.findMany({
      where: { userId: params.userId },
      select: { id: true, pushToken: true },
    });
    if (devices.length === 0) {
      await this.trace(params, rendered.title, 'SKIPPED', null, null, 'Aucun appareil enregistré');
      return;
    }

    let status: 'SENT' | 'FAILED' = 'SENT';
    let externalId: string | null = null;
    let failureReason: string | null = null;

    try {
      if (this.driver === 'expo') {
        externalId = await this.sendViaExpo(params, rendered.title, rendered.body, devices);
      } else {
        this.outbox.push({
          userId: params.userId,
          tokens: devices.map((device) => device.pushToken),
          templateKey: params.templateKey,
          title: rendered.title,
          body: rendered.body,
          locale: params.locale,
          data: params.data,
        });
        this.logger.log(
          `[push simulé] → ${devices.length} appareil(s) : ${rendered.title} — ${rendered.body}`,
        );
      }
    } catch (error) {
      status = 'FAILED';
      failureReason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Envoi push échoué (${params.templateKey})`, error);
    }

    await this.trace(
      params,
      rendered.title,
      status,
      devices.map((device) => device.pushToken).join(','),
      externalId,
      failureReason,
    );
  }

  /* -------------------------------- Interne ------------------------------ */

  private async trace(
    params: SendPushParams,
    subject: string,
    status: 'SENT' | 'FAILED' | 'SKIPPED',
    destination: string | null,
    externalId: string | null,
    failureReason: string | null,
  ): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: params.userId,
          category: 'TRANSACTIONAL',
          channel: 'PUSH',
          status,
          templateKey: params.templateKey,
          destination,
          subject,
          payload: params.variables,
          orderId: params.orderId ?? null,
          externalId,
          failureReason,
          idempotencyKey: params.idempotencyKey,
          sentAt: status === 'SENT' ? new Date() : null,
        },
      });
    } catch (error) {
      // Course sur la clé unique (deux jalons simultanés) : le premier gagne.
      this.logger.warn(`Trace push impossible (${params.templateKey}) : ${String(error)}`);
    }
  }

  private async sendViaExpo(
    params: SendPushParams,
    title: string,
    body: string,
    devices: Array<{ id: string; pushToken: string }>,
  ): Promise<string | null> {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.expoAccessToken ? { authorization: `Bearer ${this.expoAccessToken}` } : {}),
      },
      body: JSON.stringify(
        devices.map((device) => ({
          to: device.pushToken,
          title,
          body,
          sound: 'default',
          data: params.data ?? {},
        })),
      ),
    });
    if (!response.ok) {
      throw new Error(`Expo Push → ${response.status} ${response.statusText}`);
    }

    const parsed = (await response.json()) as { data?: ExpoPushTicket[] };
    const tickets = parsed.data ?? [];

    // Auto-réparation : un jeton « DeviceNotRegistered » est mort (app
    // désinstallée) — l'appareil est retiré du carnet.
    const deadDeviceIds = devices
      .filter((_, index) => tickets[index]?.details?.error === 'DeviceNotRegistered')
      .map((device) => device.id);
    if (deadDeviceIds.length > 0) {
      await this.prisma.userDevice.deleteMany({ where: { id: { in: deadDeviceIds } } });
      this.logger.log(
        `${deadDeviceIds.length} appareil(s) désenregistré(s) (DeviceNotRegistered).`,
      );
    }

    const okIds = tickets
      .filter((ticket) => ticket.status === 'ok' && ticket.id)
      .map((ticket) => ticket.id as string);
    if (okIds.length === 0 && tickets.length > 0) {
      throw new Error(tickets[0]?.message ?? 'Tous les jetons ont été refusés par Expo.');
    }
    return okIds.join(',') || null;
  }
}
