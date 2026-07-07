import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { LOCALES, type Locale } from '@ffc/core';

const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

/* --------------------------------- Auth admin -------------------------------- */

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@filtrationmontreal.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}

export class AdminMfaLoginDto {
  @ApiProperty({ description: 'Jeton de défi retourné par POST /admin/auth/login' })
  @IsString()
  @MaxLength(128)
  challengeToken!: string;

  @ApiProperty({ description: 'Code TOTP à 6 chiffres ou code de secours' })
  @IsString()
  @MaxLength(20)
  code!: string;
}

export class StepUpDto {
  @ApiProperty({ description: 'Code TOTP à 6 chiffres ou code de secours' })
  @IsString()
  @MaxLength(20)
  code!: string;
}

export class AdminLoginChallengeDto {
  @ApiProperty({ description: 'À présenter à POST /admin/auth/login/mfa (valide 5 minutes)' })
  challengeToken!: string;
}

export class AdminRoleSummaryDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;
}

export class AdminProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true, type: String })
  firstName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastName!: string | null;

  @ApiProperty({ type: [AdminRoleSummaryDto] })
  roles!: AdminRoleSummaryDto[];

  @ApiProperty({ type: [String], description: 'Permissions effectives (« * » = toutes)' })
  permissions!: string[];

  @ApiProperty()
  mfaEnabled!: boolean;
}

export class AdminSessionDto {
  @ApiProperty({ description: 'JWT Bearer de 15 minutes' })
  accessToken!: string;

  @ApiProperty({ description: 'Refresh token opaque (aussi posé en cookie httpOnly)' })
  refreshToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Durée de vie de l’access token (secondes)' })
  expiresIn!: number;

  @ApiProperty({ type: AdminProfileDto })
  profile!: AdminProfileDto;
}

export class StepUpResponseDto {
  @ApiProperty({ description: 'À joindre en en-tête X-Step-Up-Token aux actions sensibles' })
  stepUpToken!: string;

  @ApiProperty({ description: 'Durée de vie du jeton de step-up (secondes)' })
  expiresIn!: number;
}

/* ------------------------------ Utilisateurs admin --------------------------- */

export class InviteAdminDto {
  @ApiProperty({ example: 'nouvel.employe@filtrationmontreal.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: [String], description: 'Clés de rôles à attribuer (au moins une)' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  roleKeys!: string[];

  @ApiPropertyOptional({ enum: LOCALES, default: 'fr' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'Jeton d’invitation reçu par courriel' })
  @IsString()
  @MaxLength(128)
  token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}

export class AssignRolesDto {
  @ApiProperty({
    type: [String],
    description: 'Ensemble complet des rôles du compte (remplace l’existant)',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  roleKeys!: string[];
}

export class AdminUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true, type: String })
  firstName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastName!: string | null;

  @ApiProperty({ enum: ['ACTIVE', 'DISABLED', 'ANONYMIZED'] })
  status!: string;

  @ApiProperty({ enum: ['CUSTOMER', 'STAFF', 'ADMIN'] })
  role!: string;

  @ApiProperty()
  mfaEnabled!: boolean;

  @ApiProperty({ type: [AdminRoleSummaryDto] })
  roles!: AdminRoleSummaryDto[];

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastLoginAt!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Invitation en attente d’acceptation',
  })
  invitedPendingAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class RoleDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  isSystem!: boolean;

  @ApiProperty({ type: [String] })
  permissions!: string[];
}

export class PermissionDto {
  @ApiProperty()
  key!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;
}

/* --------------------------------- Journal d’audit --------------------------- */

export class AuditLogQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Filtrer par acteur' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ description: 'Filtrer par type d’entité (ex. user, order)' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityType?: string;

  @ApiPropertyOptional({ description: 'Filtrer par identifiant d’entité' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityId?: string;

  @ApiPropertyOptional({ description: 'Filtrer par action (préfixe, ex. admin.users)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Début de période (inclus)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Fin de période (exclus)' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Curseur : id de la dernière ligne reçue' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  actorType!: string;

  @ApiProperty({ nullable: true, type: String })
  actorId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  actorEmail!: string | null;

  @ApiProperty()
  action!: string;

  @ApiProperty({ nullable: true, type: String })
  entityType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  entityId!: string | null;

  @ApiProperty({ nullable: true, type: Object })
  before!: unknown;

  @ApiProperty({ nullable: true, type: Object })
  after!: unknown;

  @ApiProperty({ nullable: true, type: Object })
  metadata!: unknown;

  @ApiProperty({ nullable: true, type: String })
  ip!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AuditLogPageDto {
  @ApiProperty({ type: [AuditLogDto] })
  items!: AuditLogDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Curseur de la page suivante (ou null)',
  })
  nextCursor!: string | null;
}

/* --------------------------------- Tableau de bord --------------------------- */

export class DashboardSummaryDto {
  @ApiProperty({ description: 'Ventes payées aujourd’hui (cents)' })
  salesTodayCents!: number;

  @ApiProperty({ description: 'Nombre de commandes payées aujourd’hui' })
  ordersTodayCount!: number;

  @ApiProperty({ description: 'Commandes à expédier (payées/en traitement)' })
  ordersToShip!: number;

  @ApiProperty({ description: 'Avis en attente de modération' })
  pendingReviews!: number;

  @ApiProperty({ description: 'Identifications IA en file de révision' })
  aiReviewQueue!: number;

  @ApiProperty({ description: 'Variantes sous le seuil de stock bas' })
  lowStock!: number;

  @ApiProperty({ enum: ['CAD', 'USD'] })
  currency!: string;
}
