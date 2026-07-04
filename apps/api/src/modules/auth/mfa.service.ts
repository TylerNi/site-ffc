import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type User } from '@prisma/client';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { decryptSecret, encryptSecret, generateRecoveryCode, sha256Hex } from './crypto.util';
import { type RequestContext } from './token.service';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
/** ±1 pas de 30 s toléré (dérive d'horloge des téléphones). */
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;
/** Émetteur affiché dans l'application d'authentification. */
const TOTP_ISSUER = 'Filtration Montréal';

export interface MfaEnrollment {
  secretBase32: string;
  otpauthUri: string;
  qrCodeDataUrl: string;
}

/**
 * MFA TOTP (RFC 6238) — tâche 05.
 *
 * - Secret de 20 octets, chiffré AES-256-GCM en base (jamais en clair).
 * - Enrôlement en deux temps : le secret reste « pending » tant qu'un
 *   premier code valide n'a pas prouvé que l'application est configurée.
 * - Codes de secours : 10 codes à usage unique, hachés SHA-256.
 * - Anti-rejeu : le pas TOTP accepté est mémorisé; un code déjà consommé
 *   est refusé même dans sa fenêtre de validité.
 * - Rôles STAFF/ADMIN : la MFA est IMPOSÉE par le serveur — désactivation
 *   refusée, et les routes admin exigent mfaEnabled (voir RolesGuard).
 */
@Injectable()
export class MfaService {
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = config.get('APP_ENCRYPTION_KEY', { infer: true });
  }

  private buildTotp(secretBase32: string, label: string): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: TOTP_ISSUER,
      label,
      algorithm: 'SHA1', // le standard de fait des applications TOTP
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
  }

  /* ----------------------------- Enrôlement ---------------------------- */

  async enroll(user: User): Promise<MfaEnrollment> {
    if (user.mfaEnabled) {
      throw new BadRequestException('La MFA est déjà active sur ce compte.');
    }
    const secretBase32 = new OTPAuth.Secret({ buffer: randomBytes(20).buffer }).base32;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaPendingSecretEnc: encryptSecret(secretBase32, this.encryptionKey) },
    });
    const otpauthUri = this.buildTotp(secretBase32, user.email).toString();
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: 'M' });
    return { secretBase32, otpauthUri, qrCodeDataUrl };
  }

  /** Active la MFA après un premier code valide; retourne les codes de secours (montrés UNE fois). */
  async activate(
    user: User,
    code: string,
    ctx: RequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    if (user.mfaEnabled) {
      throw new BadRequestException('La MFA est déjà active sur ce compte.');
    }
    if (!user.mfaPendingSecretEnc) {
      throw new BadRequestException(
        "Aucun enrôlement en cours — appelez d'abord /auth/mfa/enroll.",
      );
    }
    const secretBase32 = decryptSecret(user.mfaPendingSecretEnc, this.encryptionKey);
    const step = this.validateTotp(secretBase32, user.email, code, null);
    if (step === null) {
      throw new BadRequestException('Code invalide. Vérifiez votre application et réessayez.');
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaSecretEnc: user.mfaPendingSecretEnc,
        mfaPendingSecretEnc: null,
        mfaLastUsedStep: step,
        mfaRecoveryCodeHashes: recoveryCodes.map((recoveryCode) => sha256Hex(recoveryCode)),
      },
    });

    await this.audit.log({
      action: 'auth.mfa.enabled',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.mail.send({
      userId: user.id,
      to: user.email,
      locale: user.locale,
      templateKey: 'mfa_enabled',
    });

    return { recoveryCodes };
  }

  /* ---------------------------- Vérification --------------------------- */

  /**
   * Vérifie un code TOTP **ou** un code de secours pour un compte MFA actif.
   * Retourne false sans effet de bord si le code est invalide.
   */
  async verifyCode(user: User, code: string, ctx: RequestContext): Promise<boolean> {
    if (!user.mfaEnabled || !user.mfaSecretEnc) return false;
    const normalized = code.trim().toUpperCase();

    // Code de secours (format XXXXX-XXXXX) — consommé définitivement.
    if (normalized.includes('-') || normalized.length > TOTP_DIGITS) {
      return this.consumeRecoveryCode(user, normalized, ctx);
    }

    const secretBase32 = decryptSecret(user.mfaSecretEnc, this.encryptionKey);
    const step = this.validateTotp(secretBase32, user.email, normalized, user.mfaLastUsedStep);
    if (step === null) return false;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaLastUsedStep: step },
    });
    return true;
  }

  /**
   * Valide un code TOTP et retourne le pas consommé, ou null.
   * `lastUsedStep` bloque le rejeu d'un code déjà accepté.
   */
  private validateTotp(
    secretBase32: string,
    label: string,
    code: string,
    lastUsedStep: number | null,
  ): number | null {
    const totp = this.buildTotp(secretBase32, label);
    const delta = totp.validate({ token: code, window: TOTP_WINDOW });
    if (delta === null) return null;
    const step = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000)) + delta;
    if (lastUsedStep !== null && step <= lastUsedStep) return null; // rejeu
    return step;
  }

  private async consumeRecoveryCode(
    user: User,
    normalized: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    const hash = sha256Hex(normalized);
    if (!user.mfaRecoveryCodeHashes.includes(hash)) return false;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        mfaRecoveryCodeHashes: user.mfaRecoveryCodeHashes.filter((existing) => existing !== hash),
      },
    });
    await this.audit.log({
      action: 'auth.mfa.recovery_code_used',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      metadata: { remaining: user.mfaRecoveryCodeHashes.length - 1 },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return true;
  }

  /* ---------------------------- Désactivation -------------------------- */

  async disable(user: User, code: string, ctx: RequestContext): Promise<void> {
    if (user.role === 'ADMIN' || user.role === 'STAFF') {
      throw new ForbiddenException(
        'La MFA est obligatoire pour les comptes du personnel — désactivation refusée.',
      );
    }
    if (!user.mfaEnabled) {
      throw new BadRequestException("La MFA n'est pas active sur ce compte.");
    }
    const valid = await this.verifyCode(user, code, ctx);
    if (!valid) {
      throw new BadRequestException('Code invalide.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: false,
        mfaSecretEnc: null,
        mfaPendingSecretEnc: null,
        mfaLastUsedStep: null,
        mfaRecoveryCodeHashes: [],
      },
    });
    await this.audit.log({
      action: 'auth.mfa.disabled',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.mail.send({
      userId: user.id,
      to: user.email,
      locale: user.locale,
      templateKey: 'mfa_disabled',
    });
  }
}
