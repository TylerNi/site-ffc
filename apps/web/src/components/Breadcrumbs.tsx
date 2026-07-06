import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Link } from '@/i18n/navigation';
import { breadcrumbJsonLd } from '@/lib/jsonld';
import { absoluteUrl, type LocalizedHref } from '@/lib/site';
import { JsonLd } from './JsonLd';

export interface Crumb {
  name: string;
  /** Absent pour le dernier élément (page courante). */
  href?: LocalizedHref;
}

/** Fil d'Ariane visible + données structurées BreadcrumbList. */
export async function Breadcrumbs({ locale, items }: { locale: Locale; items: Crumb[] }) {
  const t = await getTranslations({ locale, namespace: 'web.a11y' });

  return (
    <nav aria-label={t('breadcrumb')} className="breadcrumbs">
      <JsonLd
        data={breadcrumbJsonLd(
          items.map((item) => ({
            name: item.name,
            url: item.href ? absoluteUrl(locale, item.href) : undefined,
          })),
        )}
      />
      <ol>
        {items.map((item, index) => (
          <li key={index}>
            {item.href ? <Link href={item.href}>{item.name}</Link> : <span>{item.name}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
