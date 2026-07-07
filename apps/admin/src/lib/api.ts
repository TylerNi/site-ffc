/** URL de base de l'API (sous-domaine dédié en production, port local en dev). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

/** Erreur API typée : porte le statut HTTP et le code applicatif éventuel. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }

  /** Le serveur exige une ré-authentification récente (step-up). */
  get isStepUpRequired(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }

  /** Session expirée / absente. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface RawRequest {
  path: string;
  method?: string;
  body?: unknown;
  accessToken?: string;
  stepUpToken?: string;
}

/** Appel HTTP bas niveau : cookies inclus (refresh web), en-têtes admin. */
export async function rawRequest<T>(req: RawRequest): Promise<T> {
  const hasBody = req.body !== undefined;
  const response = await fetch(`${API_URL}${req.path}`, {
    method: req.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(req.accessToken ? { authorization: `Bearer ${req.accessToken}` } : {}),
      ...(req.stepUpToken ? { 'x-step-up-token': req.stepUpToken } : {}),
    },
    body: hasBody ? JSON.stringify(req.body) : undefined,
  });

  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new AdminApiError(
      response.status,
      extractMessage(data) ?? response.statusText,
      extractCode(data),
    );
  }
  return data as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function extractMessage(data: unknown): string | undefined {
  const record = asRecord(data);
  const message = record?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(' · ');
  // Réponse 403 personnalisée : { code, message }.
  const nested = asRecord(message);
  if (typeof nested?.message === 'string') return nested.message;
  return undefined;
}

function extractCode(data: unknown): string | undefined {
  const record = asRecord(data);
  if (typeof record?.code === 'string') return record.code;
  const message = asRecord(record?.message);
  if (typeof message?.code === 'string') return message.code;
  return undefined;
}
