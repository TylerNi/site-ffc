import { UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type SocialProvider = 'google' | 'apple';

/** Identité extraite d'un ID token OIDC vérifié. */
export interface OidcIdentity {
  provider: SocialProvider;
  /** `sub` du fournisseur — identifiant stable du compte social. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
}

/**
 * Vérificateur d'ID token OIDC. Interface injectée (jeton DI
 * `OIDC_VERIFIERS`) pour que les tests substituent un émetteur local
 * signé par un JWKS de test.
 */
export interface OidcVerifier {
  readonly provider: SocialProvider;
  /** Vérifie signature, émetteur, audience et expiration ; lance 401 sinon. */
  verify(idToken: string): Promise<OidcIdentity>;
}

export const OIDC_VERIFIERS = Symbol('OIDC_VERIFIERS');

interface JoseVerifierOptions {
  provider: SocialProvider;
  jwksUri: string;
  /** Émetteurs acceptés (Google en publie deux graphies). */
  issuers: string[];
  /** Client IDs acceptés comme audience (env GOOGLE/APPLE_CLIENT_IDS). */
  audiences: string[];
}

/**
 * Implémentation `jose` : JWKS distant mis en cache (rafraîchi
 * automatiquement à la rotation des clés du fournisseur).
 */
export class JoseOidcVerifier implements OidcVerifier {
  readonly provider: SocialProvider;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: JoseVerifierOptions) {
    this.provider = options.provider;
    this.jwks = createRemoteJWKSet(new URL(options.jwksUri));
  }

  async verify(idToken: string): Promise<OidcIdentity> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(idToken, this.jwks, {
        issuer: this.options.issuers,
        audience: this.options.audiences,
      });
      payload = result.payload;
    } catch {
      throw new UnauthorizedException(`Jeton ${this.provider} invalide.`);
    }
    return extractIdentity(this.provider, payload);
  }
}

/** Mappe les claims OIDC (Google/Apple) vers notre identité neutre. */
export function extractIdentity(provider: SocialProvider, payload: JWTPayload): OidcIdentity {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new UnauthorizedException(`Jeton ${provider} invalide.`);
  }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  // Apple renvoie parfois email_verified en chaîne « true »/« false ».
  const rawVerified = payload.email_verified;
  const emailVerified = rawVerified === true || rawVerified === 'true';
  return {
    provider,
    subject: payload.sub,
    email,
    emailVerified,
    givenName: typeof payload.given_name === 'string' ? payload.given_name : null,
    familyName: typeof payload.family_name === 'string' ? payload.family_name : null,
  };
}

/** Fabrique les vérificateurs de production selon les client IDs configurés. */
export function buildProductionVerifiers(config: {
  googleClientIds: string[];
  appleClientIds: string[];
}): OidcVerifier[] {
  const verifiers: OidcVerifier[] = [];
  if (config.googleClientIds.length > 0) {
    verifiers.push(
      new JoseOidcVerifier({
        provider: 'google',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        issuers: ['https://accounts.google.com', 'accounts.google.com'],
        audiences: config.googleClientIds,
      }),
    );
  }
  if (config.appleClientIds.length > 0) {
    verifiers.push(
      new JoseOidcVerifier({
        provider: 'apple',
        jwksUri: 'https://appleid.apple.com/auth/keys',
        issuers: ['https://appleid.apple.com'],
        audiences: config.appleClientIds,
      }),
    );
  }
  return verifiers;
}
