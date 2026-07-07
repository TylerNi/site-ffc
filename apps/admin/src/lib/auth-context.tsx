'use client';

import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Field, Input, Modal } from '@/components/ui';
import { AdminApiError, rawRequest } from './api';
import { type AdminProfile, type AdminSession } from './types';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Joint le jeton de step-up (actions sensibles). */
  sensitive?: boolean;
}

interface AdminAuthValue {
  status: Status;
  profile: AdminProfile | null;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<string>;
  completeMfa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Appel API authentifié (rafraîchit le jeton sur 401). */
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  /** Mutation sensible : garantit un step-up récent, puis appelle l'API. */
  mutate: <T>(path: string, options?: RequestOptions) => Promise<T>;
  refreshProfile: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthValue | null>(null);

export function useAdminAuth(): AdminAuthValue {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error('useAdminAuth doit être utilisé sous AdminAuthProvider');
  return context;
}

/** Marge avant expiration pour considérer un step-up encore utilisable. */
const STEP_UP_SAFETY_MS = 5_000;

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('admin');
  const tRef = useRef(t);
  tRef.current = t;

  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<AdminProfile | null>(null);

  const accessTokenRef = useRef<string | null>(null);
  const stepUpRef = useRef<{ token: string; expiresAt: number } | null>(null);

  // Résolveur de la promesse ouverte pendant que la fenêtre de step-up s'affiche.
  const stepUpResolver = useRef<((ok: boolean) => void) | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  const forceLogout = useCallback((): void => {
    accessTokenRef.current = null;
    stepUpRef.current = null;
    setProfile(null);
    setStatus('anonymous');
  }, []);

  const doRefresh = useCallback(async (): Promise<boolean> => {
    try {
      const refreshed = await rawRequest<{ accessToken: string }>({
        path: '/v1/auth/refresh',
        method: 'POST',
      });
      accessTokenRef.current = refreshed.accessToken;
      return true;
    } catch {
      return false;
    }
  }, []);

  const request = useCallback(
    async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
      const send = (token: string | null): Promise<T> =>
        rawRequest<T>({
          path: `/v1${path}`,
          method: options.method,
          body: options.body,
          accessToken: token ?? undefined,
          stepUpToken: options.sensitive ? stepUpRef.current?.token : undefined,
        });

      try {
        return await send(accessTokenRef.current);
      } catch (error) {
        if (error instanceof AdminApiError && error.isUnauthorized && (await doRefresh())) {
          try {
            return await send(accessTokenRef.current);
          } catch (retryError) {
            if (retryError instanceof AdminApiError && retryError.isUnauthorized) forceLogout();
            throw retryError;
          }
        }
        if (error instanceof AdminApiError && error.isUnauthorized) forceLogout();
        throw error;
      }
    },
    [doRefresh, forceLogout],
  );

  const isStepUpValid = (): boolean => {
    const current = stepUpRef.current;
    return current !== null && current.expiresAt > Date.now() + STEP_UP_SAFETY_MS;
  };

  const acquireStepUp = useCallback(
    async (code: string): Promise<void> => {
      const issue = (token: string | null): Promise<{ stepUpToken: string; expiresIn: number }> =>
        rawRequest({
          path: '/v1/admin/auth/step-up',
          method: 'POST',
          body: { code },
          accessToken: token ?? undefined,
        });
      let result;
      try {
        result = await issue(accessTokenRef.current);
      } catch (error) {
        if (error instanceof AdminApiError && error.isUnauthorized && (await doRefresh())) {
          result = await issue(accessTokenRef.current);
        } else {
          throw error;
        }
      }
      stepUpRef.current = {
        token: result.stepUpToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      };
    },
    [doRefresh],
  );

  const ensureStepUp = useCallback((): Promise<boolean> => {
    if (isStepUpValid()) return Promise.resolve(true);
    setStepUpError(null);
    setStepUpOpen(true);
    return new Promise<boolean>((resolve) => {
      stepUpResolver.current = resolve;
    });
  }, []);

  const submitStepUp = useCallback(
    async (code: string): Promise<void> => {
      try {
        await acquireStepUp(code);
        setStepUpOpen(false);
        stepUpResolver.current?.(true);
        stepUpResolver.current = null;
      } catch {
        setStepUpError(tRef.current('stepUp.error'));
      }
    },
    [acquireStepUp],
  );

  const cancelStepUp = useCallback((): void => {
    setStepUpOpen(false);
    stepUpResolver.current?.(false);
    stepUpResolver.current = null;
  }, []);

  const mutate = useCallback(
    async function mutate<T>(path: string, options: RequestOptions = {}): Promise<T> {
      if (!(await ensureStepUp())) {
        throw new AdminApiError(0, 'Ré-authentification annulée.', 'CANCELLED');
      }
      try {
        return await request<T>(path, { ...options, sensitive: true });
      } catch (error) {
        // Jeton de step-up expiré entre-temps : on redemande une fois.
        if (error instanceof AdminApiError && error.isStepUpRequired) {
          stepUpRef.current = null;
          if (!(await ensureStepUp())) throw error;
          return request<T>(path, { ...options, sensitive: true });
        }
        throw error;
      }
    },
    [ensureStepUp, request],
  );

  const loadProfile = useCallback(async (): Promise<void> => {
    const loaded = await request<AdminProfile>('/admin/auth/me');
    setProfile(loaded);
    setStatus('authenticated');
  }, [request]);

  const login = useCallback(async (email: string, password: string): Promise<string> => {
    const result = await rawRequest<{ challengeToken: string }>({
      path: '/v1/admin/auth/login',
      method: 'POST',
      body: { email, password },
    });
    return result.challengeToken;
  }, []);

  const completeMfa = useCallback(async (challengeToken: string, code: string): Promise<void> => {
    const session = await rawRequest<AdminSession>({
      path: '/v1/admin/auth/login/mfa',
      method: 'POST',
      body: { challengeToken, code },
    });
    accessTokenRef.current = session.accessToken;
    setProfile(session.profile);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await rawRequest({ path: '/v1/admin/auth/logout', method: 'POST' });
    } catch {
      // déconnexion « au mieux »
    }
    forceLogout();
  }, [forceLogout]);

  const refreshProfile = useCallback(async (): Promise<void> => {
    await loadProfile();
  }, [loadProfile]);

  const can = useCallback(
    (permission: string): boolean =>
      profile?.permissions.includes('*') === true ||
      profile?.permissions.includes(permission) === true,
    [profile],
  );

  // Restaure la session au chargement (cookie de refresh httpOnly).
  useEffect(() => {
    let active = true;
    void (async () => {
      if (await doRefresh()) {
        try {
          const loaded = await rawRequest<AdminProfile>({
            path: '/v1/admin/auth/me',
            accessToken: accessTokenRef.current ?? undefined,
          });
          if (active) {
            setProfile(loaded);
            setStatus('authenticated');
          }
          return;
        } catch {
          // profil inaccessible → anonyme
        }
      }
      if (active) setStatus('anonymous');
    })();
    return () => {
      active = false;
    };
  }, [doRefresh]);

  const value = useMemo<AdminAuthValue>(
    () => ({ status, profile, can, login, completeMfa, logout, request, mutate, refreshProfile }),
    [status, profile, can, login, completeMfa, logout, request, mutate, refreshProfile],
  );

  return (
    <AdminAuthContext.Provider value={value}>
      {children}
      <StepUpDialog
        open={stepUpOpen}
        error={stepUpError}
        onSubmit={submitStepUp}
        onCancel={cancelStepUp}
      />
    </AdminAuthContext.Provider>
  );
}

/* ------------------------- Fenêtre de ré-authentification ------------------- */

function StepUpDialog({
  open,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  error: string | null;
  onSubmit: (code: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('admin.stepUp');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setCode('');
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit(code);
    setSubmitting(false);
  }

  return (
    <Modal open={open} title={t('title')} onClose={onCancel}>
      <p className="modal-subtitle">{t('subtitle')}</p>
      <form onSubmit={handleSubmit}>
        <Field label={t('code')}>
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
          />
        </Field>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
