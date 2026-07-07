'use client';

import { type FormEvent, Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { AdminApiError, rawRequest } from '@/lib/api';

// useSearchParams impose une frontière Suspense pour la génération statique.
export default function InvitationPage() {
  return (
    <Suspense fallback={<div className="auth-screen" />}>
      <InvitationForm />
    </Suspense>
  );
}

function InvitationForm() {
  const t = useTranslations('admin.invitation');
  const token = useSearchParams().get('token');

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) {
      setError(t('missingToken'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await rawRequest({
        path: '/v1/admin/invitations/accept',
        method: 'POST',
        body: { token, password },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : t('missingToken'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">{t('title')}</h1>

        {done ? (
          <>
            <Alert kind="success">{t('success')}</Alert>
            <p className="auth-subtitle">{t('mfaReminder')}</p>
            <Link className="auth-link" href="/connexion">
              {t('goToLogin')}
            </Link>
          </>
        ) : !token ? (
          <Alert kind="error">{t('missingToken')}</Alert>
        ) : (
          <>
            <p className="auth-subtitle">{t('subtitle')}</p>
            <form onSubmit={handleSubmit}>
              <Field label={t('password')} hint={t('passwordHint')}>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={10}
                  autoFocus
                  required
                />
              </Field>
              {error ? <Alert kind="error">{error}</Alert> : null}
              <p className="auth-note">{t('mfaReminder')}</p>
              <Button type="submit" variant="primary" loading={submitting} className="auth-submit">
                {t('submit')}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
