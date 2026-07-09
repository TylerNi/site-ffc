import { type MesCommandesLabels } from './MesCommandes';

/** Traducteur next-intl restreint au namespace « web.account ». */
type T = (key: string) => string;

/** Construit le paquet de libellés de « Mes commandes » depuis les traductions. */
export function buildAccountLabels(t: T): MesCommandesLabels {
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
    listTitle: t('listTitle'),
    detailTitle: t('detailTitle'),
    empty: t('empty'),
    browse: t('browse'),
    order: t('order'),
    date: t('date'),
    status: t('status'),
    total: t('total'),
    view: t('view'),
    back: t('back'),
    items: t('items'),
    quantity: t('quantity'),
    invoice: t('invoice'),
    downloadInvoice: t('downloadInvoice'),
    invoicePending: t('invoicePending'),
    cancel: t('cancel'),
    cancelConfirm: t('cancelConfirm'),
    cancelling: t('cancelling'),
    cancelled: t('cancelled'),
    refundNote: t('refundNote'),
    timeline: t('timeline'),
    shippingAddress: t('shippingAddress'),
    subtotal: t('subtotal'),
    discount: t('discount'),
    shipping: t('shipping'),
    free: t('free'),
    gst: t('gst'),
    qst: t('qst'),
    hst: t('hst'),
    pst: t('pst'),
    paidWith: t('paidWith'),
    loading: t('loading'),
    loadError: t('loadError'),
    retry: t('retry'),
    signOut: t('signOut'),
    actorClient: t('actorClient'),
    actorAdmin: t('actorAdmin'),
    actorSystem: t('actorSystem'),
  };
}
