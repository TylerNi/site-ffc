import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { LOCALES, type Locale, USER_ROLES, type UserRole } from '@ffc/core';

/**
 * Politique de mot de passe (docs/auth.md) : longueur avant complexité
 * (NIST 800-63B) — 10 caractères minimum, 128 maximum, aucun jeu de
 * caractères imposé.
 */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

/* --------------------------------- Requêtes -------------------------------- */

export class RegisterDto {
  @ApiProperty({ example: 'marie@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;

  @ApiPropertyOptional({ example: 'Marie' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Tremblay' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ enum: LOCALES, default: 'fr' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @ApiPropertyOptional({ description: 'Jeton de panier invité à fusionner dans le compte' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  guestCartToken?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'marie@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX)
  password!: string;

  @ApiPropertyOptional({ description: 'Jeton de panier invité à fusionner à la connexion' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  guestCartToken?: string;
}

export class MfaLoginDto {
  @ApiProperty({ description: 'Jeton de défi retourné par POST /auth/login (mfaRequired=true)' })
  @IsString()
  @MaxLength(128)
  challengeToken!: string;

  @ApiProperty({ description: 'Code TOTP à 6 chiffres ou code de secours XXXXX-XXXXX' })
  @IsString()
  @MaxLength(20)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  guestCartToken?: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description: 'Refresh token (mobile). Le web utilise plutôt le cookie httpOnly.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  refreshToken?: string;
}

export class EmailOnlyDto {
  @ApiProperty({ example: 'marie@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Jeton reçu par courriel' })
  @IsString()
  @MaxLength(128)
  token!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Jeton reçu par courriel' })
  @IsString()
  @MaxLength(128)
  token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX)
  currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  newPassword!: string;
}

export class MfaCodeDto {
  @ApiProperty({ description: 'Code TOTP à 6 chiffres ou code de secours XXXXX-XXXXX' })
  @IsString()
  @MaxLength(20)
  code!: string;
}

export class SocialLoginDto {
  @ApiProperty({ description: 'ID token OIDC émis par Google ou Apple' })
  @IsString()
  @MaxLength(4096)
  idToken!: string;

  @ApiPropertyOptional({ enum: LOCALES, default: 'fr' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @ApiPropertyOptional({ description: 'Prénom (Apple ne le transmet qu’à la première connexion)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  guestCartToken?: string;
}

/* --------------------------------- Réponses -------------------------------- */

export class MessageResponseDto {
  @ApiProperty()
  message!: string;
}

export class UserProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true, type: String })
  firstName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastName!: string | null;

  @ApiProperty({ enum: USER_ROLES })
  role!: UserRole;

  @ApiProperty({ enum: LOCALES })
  locale!: Locale;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty()
  mfaEnabled!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export function toUserProfile(user: User): UserProfileDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    locale: user.locale,
    emailVerified: user.emailVerifiedAt !== null,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

export class LoginResponseDto {
  @ApiProperty({ description: 'true = fournir un code via POST /auth/login/mfa' })
  mfaRequired!: boolean;

  @ApiPropertyOptional({ description: 'Présent si mfaRequired — valide 5 minutes' })
  challengeToken?: string;

  @ApiPropertyOptional({ description: 'JWT Bearer de 15 minutes' })
  accessToken?: string;

  @ApiPropertyOptional({
    description: 'Refresh token opaque (aussi posé en cookie httpOnly pour le web)',
  })
  refreshToken?: string;

  @ApiPropertyOptional({ enum: ['Bearer'] })
  tokenType?: 'Bearer';

  @ApiPropertyOptional({ description: 'Durée de vie de l’access token (secondes)' })
  expiresIn?: number;

  @ApiPropertyOptional({ type: UserProfileDto })
  user?: UserProfileDto;
}

export class RefreshResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty()
  expiresIn!: number;
}

export class SessionItemDto {
  @ApiProperty({ format: 'uuid', description: 'Id de session (famille de refresh tokens)' })
  id!: string;

  @ApiProperty({ format: 'date-time', description: 'Ouverture de la session (connexion)' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Dernier rafraîchissement' })
  lastActiveAt!: string;

  @ApiProperty({ nullable: true, type: String })
  ip!: string | null;

  @ApiProperty({ nullable: true, type: String })
  userAgent!: string | null;

  @ApiProperty({ description: 'Session portant la requête courante' })
  current!: boolean;
}

export class RevokeSessionsResponseDto {
  @ApiProperty({ description: 'Nombre de sessions révoquées' })
  revokedSessions!: number;
}

export class MfaEnrollResponseDto {
  @ApiProperty({ description: 'Secret TOTP en base32 (saisie manuelle)' })
  secretBase32!: string;

  @ApiProperty({ description: 'URI otpauth:// pour les applications TOTP' })
  otpauthUri!: string;

  @ApiProperty({ description: 'QR d’enrôlement en data URL PNG' })
  qrCodeDataUrl!: string;
}

export class MfaActivateResponseDto {
  @ApiProperty({
    type: [String],
    description: 'Codes de secours à usage unique — montrés UNE seule fois',
  })
  recoveryCodes!: string[];
}

export class GuestCartResponseDto {
  @ApiProperty({ description: 'Jeton opaque du panier invité (à conserver côté client)' })
  guestCartToken!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}
