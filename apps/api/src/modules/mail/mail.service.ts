import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Locale } from '@ffc/core';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { type MailTemplateKey, renderMail } from './templates';

export interface SendMailParams {
  /** Compte destinataire (null pour un destinataire hors plateforme). */
  userId?: string | null;
  to: string;
  locale: Locale;
  templateKey: MailTemplateKey;
  /** Variables du gabarit persistées dans `notifications.payload`. */
  variables?: Record<string, string>;
  /**
   * Variables SECRÈTES (liens porteurs d'un jeton…) : utilisées pour le
   * rendu seulement, JAMAIS persistées en base.
   */
  secretVariables?: Record<string, string>;
  /**
   * false = aucune ligne `notifications` (cas unique : confirmation de
   * suppression de compte — la trace retiendrait l'adresse effacée).
   */
  recordTrace?: boolean;
}

/** Courriel capturé par le driver `log` — consommé par les tests. */
export interface OutboxEntry {
  to: string;
  templateKey: MailTemplateKey;
  subject: string;
  text: string;
  variables: Record<string, string>;
}

/**
 * Courriels transactionnels de sécurité, envoyés via AWS SES (production)
 * ou capturés en mémoire + console (driver `log`, dev/test).
 *
 * Chaque tentative laisse une trace dans `notifications` (statut
 * SENT/FAILED, id de message SES) — sans aucune variable secrète.
 * L'envoi est « best effort » : un échec SES est consigné mais ne fait pas
 * échouer le parcours d'authentification appelant.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly driver: Env['MAIL_DRIVER'];
  private readonly from: string;
  private sesClient: SESv2Client | null = null;

  /** Boîte d'envoi mémoire du driver `log` (assertions de test). */
  readonly outbox: OutboxEntry[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.driver = this.config.get('MAIL_DRIVER', { infer: true });
    this.from = this.config.get('MAIL_FROM', { infer: true });
  }

  async send(params: SendMailParams): Promise<void> {
    const variables = params.variables ?? {};
    const rendered = renderMail(params.templateKey, params.locale, {
      ...variables,
      ...params.secretVariables,
    });

    let status: 'SENT' | 'FAILED' = 'SENT';
    let externalId: string | null = null;
    let failureReason: string | null = null;

    try {
      if (this.driver === 'ses') {
        externalId = await this.sendViaSes(params.to, rendered.subject, rendered.text);
      } else {
        this.outbox.push({
          to: params.to,
          templateKey: params.templateKey,
          subject: rendered.subject,
          text: rendered.text,
          variables: { ...variables, ...params.secretVariables },
        });
        this.logger.log(`[courriel simulé] → ${params.to} : ${rendered.subject}`);
      }
    } catch (error) {
      status = 'FAILED';
      failureReason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Envoi SES échoué → ${params.to} (${params.templateKey})`, error);
    }

    if (params.recordTrace === false) return;

    try {
      await this.prisma.notification.create({
        data: {
          userId: params.userId ?? null,
          category: 'TRANSACTIONAL',
          channel: 'EMAIL',
          status,
          templateKey: params.templateKey,
          destination: params.to,
          subject: rendered.subject,
          // Trace SANS les variables secrètes (jetons de vérification, etc.).
          payload: variables,
          externalId,
          failureReason,
          sentAt: status === 'SENT' ? new Date() : null,
        },
      });
    } catch (error) {
      this.logger.error(`Trace de notification impossible (${params.templateKey})`, error);
    }
  }

  private async sendViaSes(to: string, subject: string, text: string): Promise<string | null> {
    this.sesClient ??= new SESv2Client({
      region: this.config.get('AWS_REGION', { infer: true }),
    });
    const result = await this.sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    return result.MessageId ?? null;
  }
}
