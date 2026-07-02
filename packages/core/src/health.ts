import { z } from 'zod';

/**
 * Réponse de `GET /v1/health` — le schéma est utilisé côté API (validation
 * de la réponse) et côté clients (validation de ce qui est reçu).
 */
export const healthStatusSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  timestamp: z.iso.datetime(),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
