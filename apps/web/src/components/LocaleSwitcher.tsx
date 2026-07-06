'use client';

import { useEffect, useState } from 'react';

/**
 * Bascule de langue. La cible exacte vient du lien hreflang de la page
 * (les slugs produits diffèrent par locale) : une seule source de vérité —
 * les métadonnées. Avant hydratation : accueil de l'autre locale.
 */
export function LocaleSwitcher({
  targetLocale,
  fallbackHref,
  label,
  ariaLabel,
}: {
  targetLocale: string;
  fallbackHref: string;
  label: string;
  ariaLabel: string;
}) {
  const [href, setHref] = useState(fallbackHref);

  useEffect(() => {
    const hreflang = targetLocale === 'fr' ? 'fr-CA' : 'en-CA';
    const link = document.querySelector<HTMLLinkElement>(
      `link[rel="alternate"][hreflang="${hreflang}"]`,
    );
    if (link?.href) setHref(link.href);
  }, [targetLocale]);

  return (
    <a className="lang-switch" href={href} lang={targetLocale} aria-label={ariaLabel}>
      {label}
    </a>
  );
}
