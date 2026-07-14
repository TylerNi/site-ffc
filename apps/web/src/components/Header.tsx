import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Link } from '@/i18n/navigation';
import { localizedPath, otherLocale } from '@/lib/site';
import { CartBadge } from './CartBadge';
import { LocaleSwitcher } from './LocaleSwitcher';
import { SearchBox } from './SearchBox';

const CLIENT_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function Header({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'web' });
  const target = otherLocale(locale);

  return (
    <header className="site-header">
      <div className="container site-header-inner">
        {/* Logo = texte seul (Poppins gras, majuscules) — aucune image. */}
        <Link href="/" className="logo">
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

        <div className="header-icons">
          <Link href="/account/orders">{t('nav.account')}</Link>
          <Link href="/cart" className="cart-link">
            <CartBadge label={t('nav.cart')} />
          </Link>
        </div>
      </div>

      {/* Barre secondaire (fond pâle) : navigation et bascule de langue. */}
      <div className="site-subnav">
        <div className="container site-subnav-inner">
          <nav aria-label={t('a11y.mainNav')}>
            <Link href="/sizes">{t('nav.sizes')}</Link>
          </nav>
          <LocaleSwitcher
            targetLocale={target}
            fallbackHref={localizedPath(target, '/')}
            label={t('header.languageSwitch')}
            ariaLabel={t('header.languageSwitchLabel')}
          />
        </div>
      </div>
    </header>
  );
}
