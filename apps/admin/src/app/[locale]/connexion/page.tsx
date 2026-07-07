'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';

type Step = 'credentials' | 'mfa';

export default function LoginPage() {
  const t = useTranslations('admin.login');
  const router = useRouter();
  const { status, login, completeMfa } = useAdminAuth();

  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Déjà connecté (session restaurée) → vers le tableau de bord.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/tableau-de-bord');
  }, [status, router]);

  function describe(err: unknown, fallback: string): string {
    if (err instanceof AdminApiError) {
      if (err.status === 403) return t('errorMfaRequired');
      if (err.status === 401) return fallback;
      return err.message;
    }
    return t('apiUnreachable');
  }

  async function handleCredentials(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const token = await login(email.trim(), password);
      setChallengeToken(token);
      setStep('mfa');
    } catch (err) {
      setError(describe(err, t('errorInvalid')));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfa(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await completeMfa(challengeToken, code.trim());
      router.replace('/tableau-de-bord');
    } catch (err) {
      setError(describe(err, t('errorCode')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">{t('title')}</h1>
        <p className="auth-subtitle">{step === 'credentials' ? t('subtitle') : t('mfaSubtitle')}</p>

        {step === 'credentials' ? (
          <form onSubmit={handleCredentials}>
            <Field label={t('email')}>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label={t('password')}>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            {error ? <Alert kind="error">{error}</Alert> : null}
            <Button type="submit" variant="primary" loading={submitting} className="auth-submit">
              {t('submit')}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleMfa}>
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
            <Button type="submit" variant="primary" loading={submitting} className="auth-submit">
              {t('mfaSubmit')}
            </Button>
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setStep('credentials');
                setError(null);
                setCode('');
              }}
            >
              {t('back')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
