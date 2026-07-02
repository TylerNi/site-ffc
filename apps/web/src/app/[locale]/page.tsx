import { getTranslations, setRequestLocale } from 'next-intl/server';
import { createApiClient } from '@ffc/api-client';
import { type HealthStatus, healthStatusSchema } from '@ffc/core';
import { Link } from '@/i18n/navigation';

// L'état de l'API est interrogé à chaque requête — pas de prérendu figé.
export const dynamic = 'force-dynamic';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fetchHealth(): Promise<HealthStatus | null> {
  try {
    const client = createApiClient({ baseUrl: API_URL });
    const { data } = await client.GET('/v1/health', { cache: 'no-store' });
    return data ? healthStatusSchema.parse(data) : null;
  } catch {
    return null;
  }
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('home');
  const health = await fetchHealth();

  return (
    <main>
      <h1>{t('title')}</h1>
      <p>{t('tagline')}</p>

      <section
        style={{
          padding: '1rem 1.25rem',
          borderRadius: '0.5rem',
          background: '#fff',
          border: '1px solid #dde2e6',
        }}
      >
        <strong>{t('apiStatus.label')}</strong>
        <p
          style={{
            margin: '0.5rem 0 0',
            color: health ? 'var(--color-ok)' : 'var(--color-error)',
          }}
        >
          {health ? t('apiStatus.ok', { version: health.version }) : t('apiStatus.unreachable')}
        </p>
      </section>

      <nav style={{ marginTop: '2rem' }}>
        <strong>{t('languageSwitch')}</strong>{' '}
        <Link href="/" locale="fr">
          Français
        </Link>
        {' · '}
        <Link href="/" locale="en">
          English
        </Link>
      </nav>
    </main>
  );
}
