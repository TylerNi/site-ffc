'use client';

import { useParams } from 'next/navigation';

/**
 * Erreur de rendu (ex. API catalogue injoignable sur une fiche produit).
 * Composant client sans contexte i18n — petit dictionnaire local.
 */
const TEXTS = {
  fr: {
    title: 'Un pépin de notre côté',
    text: 'Le catalogue est momentanément indisponible. Réessayez dans quelques instants.',
    retry: 'Réessayer',
  },
  en: {
    title: 'Something went wrong on our end',
    text: 'The catalogue is briefly unavailable. Please try again in a moment.',
    retry: 'Try again',
  },
} as const;

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const params = useParams<{ locale?: string }>();
  const texts = params.locale === 'fr' ? TEXTS.fr : TEXTS.en;

  return (
    <main className="main container">
      <div className="empty-state" style={{ paddingBlock: '4rem' }}>
        <h1>{texts.title}</h1>
        <p>{texts.text}</p>
        <button type="button" className="btn" onClick={reset}>
          {texts.retry}
        </button>
      </div>
    </main>
  );
}
