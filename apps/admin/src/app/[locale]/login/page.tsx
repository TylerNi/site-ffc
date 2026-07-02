'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createApiClient } from '@ffc/api-client';
import { Link } from '@/i18n/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type ApiState = 'checking' | 'ok' | 'unreachable';

export default function LoginPage() {
  const t = useTranslations('admin.login');
  const [submitted, setSubmitted] = useState(false);
  const [apiState, setApiState] = useState<ApiState>('checking');

  useEffect(() => {
    const client = createApiClient({ baseUrl: API_URL });
    client
      .GET('/v1/health')
      .then(({ data }) => setApiState(data?.status === 'ok' ? 'ok' : 'unreachable'))
      .catch(() => setApiState('unreachable'));
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // Connexion factice — l'authentification réelle arrive aux tâches 05 et 09.
    event.preventDefault();
    setSubmitted(true);
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      <p style={{ opacity: 0.75 }}>{t('demoNotice')}</p>

      <form onSubmit={handleSubmit}>
        <label>
          {t('email')}
          <input type="email" name="email" autoComplete="username" required />
        </label>
        <label>
          {t('password')}
          <input type="password" name="password" autoComplete="current-password" required />
        </label>
        <button type="submit">{t('submit')}</button>
      </form>

      {submitted ? <p style={{ color: 'var(--color-ok)' }}>{t('submitted')}</p> : null}

      <p style={{ marginTop: '2.5rem', fontSize: '0.875rem', opacity: 0.75 }}>
        {apiState === 'checking' && t('apiChecking')}
        {apiState === 'ok' && t('apiOk')}
        {apiState === 'unreachable' && t('apiUnreachable')}
      </p>

      <p style={{ fontSize: '0.875rem' }}>
        <Link href="/login" locale="fr">
          Français
        </Link>
        {' · '}
        <Link href="/login" locale="en">
          English
        </Link>
      </p>
    </main>
  );
}
