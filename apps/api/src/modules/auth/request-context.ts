import { type User } from '@prisma/client';
import { type Request } from 'express';
import { type AccessTokenClaims, type RequestContext } from './token.service';

/** Requête Express enrichie par JwtAuthGuard. */
export interface AuthenticatedRequest extends Request {
  user?: User;
  authClaims?: AccessTokenClaims;
}

const MAX_USER_AGENT_LENGTH = 400;

/** Contexte réseau consigné avec les jetons et l'audit. */
export function requestContext(req: Request): RequestContext {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}
