import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Link } from '@/i18n/navigation';
import { localizedPath, otherLocale } from '@/lib/site';
import { CartBadge } from './CartBadge';
import { LocaleSwitcher } from './LocaleSwitcher';
import { SearchBox } from './SearchBox';

const CLIENT_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Pictogramme filtre à plis (logo). */
function LogoMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="6" fill="var(--brand)" />
      <path
        d="M5 8 l4 10 l4 -10 l4 10 l4 -10"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export async function Header({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'web' });
  const target = otherLocale(locale);

  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Link href="/" className="logo">
          <LogoMark />
          {t('meta.siteName')}
        </Link>

        <SearchBox
          locale={locale}
          searchPath={localizedPath(locale, '/search')}
          sizesBasePath={localizedPath(locale, '/sizes')}
          productsBasePath={localizedPath(locale, {
            pathname: '/products/[slug]',
            params: { slug: '_' },
          }).replace(/\/_$/, '')}
          apiUrl={CLIENT_API_URL}
          labels={{
            label: t('header.searchLabel'),
            placeholder: t('header.searchPlaceholder'),
            submit: t('header.searchSubmit'),
            sizes: t('header.suggestSizes'),
            products: t('header.suggestProducts'),
            suggestions: t('a11y.searchSuggestions'),
          }}
        />

        <nav className="site-nav" aria-label={t('a11y.mainNav')}>
          <Link href="/sizes">{t('nav.sizes')}</Link>
          <Link href="/account/orders">{t('nav.account')}</Link>
          <LocaleSwitcher
            targetLocale={target}
            fallbackHref={localizedPath(target, '/')}
            label={t('header.languageSwitch')}
            ariaLabel={t('header.languageSwitchLabel')}
          />
          <Link href="/cart" className="cart-link">
            <CartBadge label={t('nav.cart')} />
          </Link>
        </nav>
      </div>
    </header>
  );
}
