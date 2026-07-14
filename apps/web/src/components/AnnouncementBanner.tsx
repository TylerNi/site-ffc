import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';

/**
 * Enveloppe stylée du bandeau d'annonce (dégradé vert de marque) — hauteur
 * fixe pour zéro CLS. Réutilise le libellé « livraison » existant en
 * attendant le compte à rebours natif (tâche 22), qui remplacera ce
 * contenu par le sien.
 */
export async function AnnouncementBanner({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'web' });

  return (
    <div className="announcement-bar">
      <div className="container announcement-bar-inner">{t('home.usp.shippingTitle')}</div>
    </div>
  );
}
