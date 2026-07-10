import { type MesColisLabels } from './MesColis';

/** Traducteur next-intl restreint au namespace « web.account ». */
type T = (key: string) => string;

/** Construit le paquet de libellés de « Mes colis » depuis les traductions. */
export function buildShipmentsLabels(t: T): MesColisLabels {
  return {
    signin: {
      heading: t('signin.heading'),
      intro: t('signin.intro'),
      email: t('signin.email'),
      password: t('signin.password'),
      submit: t('signin.submit'),
      submitting: t('signin.submitting'),
      error: t('signin.error'),
    },
    title: t('shipments.title'),
    empty: t('shipments.empty'),
    emptyHint: t('shipments.emptyHint'),
    browse: t('browse'),
    active: t('shipments.active'),
    history: t('shipments.history'),
    order: t('order'),
    viewOrder: t('view'),
    trackOnCarrier: t('shipments.trackOnCarrier'),
    eta: t('shipments.eta'),
    deliveredOn: t('shipments.deliveredOn'),
    timeline: t('shipments.timeline'),
    noEvents: t('shipments.noEvents'),
    loading: t('loading'),
    loadError: t('shipments.loadError'),
    retry: t('retry'),
    signOut: t('signOut'),
    myOrders: t('listTitle'),
  };
}
