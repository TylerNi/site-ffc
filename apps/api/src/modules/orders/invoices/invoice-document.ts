import { type InvoiceKind } from '@prisma/client';
import { formatMoneyCents, type Locale } from '@ffc/core';
import { type CompanyBillingInfo } from './company-info';

/**
 * Modèle de document de facture / note de crédit (tâche 12) — PUR et
 * bilingue. Il résout tous les libellés selon la locale du client, formate
 * les montants, et expose une représentation texte : le rendu PDF
 * (invoice-pdf.renderer.ts) consomme ce modèle, et les tests vérifient le
 * CONTENU ici (mentions FR, ventilation TPS/TVQ, numéros d'inscription)
 * sans avoir à extraire du texte d'un PDF.
 *
 * Entreprise québécoise : facture en français par défaut (Loi 96), numéros
 * de TPS et de TVQ toujours affichés.
 */

export interface AddressSnapshot {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
}

export interface InvoiceLineInput {
  sku: string;
  nameFr: string;
  nameEn: string;
  nominalLabel?: string | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxGstCents: number;
  taxQstCents: number;
  taxHstCents: number;
  taxPstCents: number;
  totalCents: number;
}

export interface InvoiceDocumentInput {
  locale: Locale;
  kind: InvoiceKind;
  invoiceNumber: string;
  issuedAt: Date;
  company: CompanyBillingInfo;
  order: {
    number: string;
    placedAt: Date;
    customerName: string | null;
    customerEmail: string;
    shippingAddress: AddressSnapshot | null;
    billingAddress: AddressSnapshot | null;
    currency: string;
    cardBrand?: string | null;
    cardLast4?: string | null;
  };
  lines: InvoiceLineInput[];
  totals: InvoiceTotals;
  /** Motif du remboursement (notes de crédit uniquement). */
  creditNoteReason?: string | null;
}

/* -------------------------------- i18n --------------------------------- */

interface Strings {
  invoiceTitle: string;
  creditNoteTitle: string;
  invoiceNo: string;
  date: string;
  orderNo: string;
  billedTo: string;
  shipTo: string;
  registrations: string;
  gstNo: string;
  qstNo: string;
  description: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  subtotal: string;
  discount: string;
  shipping: string;
  free: string;
  gst: string;
  qst: string;
  hst: string;
  pst: string;
  total: string;
  creditTotal: string;
  paidBy: string;
  card: string;
  reason: string;
  thanks: string;
  creditNotice: string;
  amountsIn: string;
}

const STRINGS: Record<Locale, Strings> = {
  fr: {
    invoiceTitle: 'FACTURE',
    creditNoteTitle: 'NOTE DE CRÉDIT',
    invoiceNo: 'Facture nº',
    date: 'Date',
    orderNo: 'Commande nº',
    billedTo: 'Facturé à',
    shipTo: 'Livré à',
    registrations: 'Numéros d’inscription',
    gstNo: 'No TPS/TVH',
    qstNo: 'No TVQ',
    description: 'Description',
    qty: 'Qté',
    unitPrice: 'Prix unitaire',
    lineTotal: 'Montant',
    subtotal: 'Sous-total',
    discount: 'Remise',
    shipping: 'Livraison',
    free: 'Gratuite',
    gst: 'TPS (5 %)',
    qst: 'TVQ (9,975 %)',
    hst: 'TVH',
    pst: 'TVP/TVD',
    total: 'Total',
    creditTotal: 'Total remboursé',
    paidBy: 'Réglé par',
    card: 'carte',
    reason: 'Motif',
    thanks: 'Merci de votre confiance.',
    creditNotice: 'Cette note de crédit fait suite à un remboursement sur la commande ci-dessus.',
    amountsIn: 'Montants en dollars canadiens (CAD).',
  },
  en: {
    invoiceTitle: 'INVOICE',
    creditNoteTitle: 'CREDIT NOTE',
    invoiceNo: 'Invoice no.',
    date: 'Date',
    orderNo: 'Order no.',
    billedTo: 'Billed to',
    shipTo: 'Shipped to',
    registrations: 'Registration numbers',
    gstNo: 'GST/HST no.',
    qstNo: 'QST no.',
    description: 'Description',
    qty: 'Qty',
    unitPrice: 'Unit price',
    lineTotal: 'Amount',
    subtotal: 'Subtotal',
    discount: 'Discount',
    shipping: 'Shipping',
    free: 'Free',
    gst: 'GST (5%)',
    qst: 'QST (9.975%)',
    hst: 'HST',
    pst: 'PST/RST',
    total: 'Total',
    creditTotal: 'Total refunded',
    paidBy: 'Paid by',
    card: 'card',
    reason: 'Reason',
    thanks: 'Thank you for your business.',
    creditNotice: 'This credit note follows a refund on the order above.',
    amountsIn: 'Amounts in Canadian dollars (CAD).',
  },
};

/* --------------------------- Modèle résolu ----------------------------- */

export interface RenderedLine {
  description: string;
  sku: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface RenderedTaxRow {
  label: string;
  amount: string;
}

export interface InvoiceDocument {
  locale: Locale;
  kind: InvoiceKind;
  title: string;
  strings: Strings;
  company: CompanyBillingInfo;
  invoiceNumber: string;
  issuedAtLabel: string;
  orderNumber: string;
  currency: string;
  customerName: string | null;
  customerEmail: string;
  shipTo: string[];
  billTo: string[];
  lines: RenderedLine[];
  subtotal: string;
  discount: string | null;
  shipping: string;
  taxRows: RenderedTaxRow[];
  total: string;
  totalLabel: string;
  paymentLine: string | null;
  creditNoteReason: string | null;
}

function fmtDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Toronto',
  }).format(date);
}

/** Adresse en lignes affichables (ignore les champs vides). */
export function formatAddressLines(address: AddressSnapshot | null): string[] {
  if (!address) return [];
  const name = [address.firstName, address.lastName].filter(Boolean).join(' ').trim();
  const cityLine = [address.city, address.province].filter(Boolean).join(', ');
  const cityPostal = [cityLine, address.postalCode].filter(Boolean).join(' ').trim();
  return [
    name,
    address.company ?? '',
    address.line1 ?? '',
    address.line2 ?? '',
    cityPostal,
    address.country && address.country !== 'CA' ? address.country : '',
    address.phone ?? '',
  ].filter((line) => line.trim().length > 0);
}

export function buildInvoiceDocument(input: InvoiceDocumentInput): InvoiceDocument {
  const { locale, totals, order, company } = input;
  const s = STRINGS[locale];
  const money = (cents: number): string => formatMoneyCents(cents, order.currency, locale);

  const lines: RenderedLine[] = input.lines.map((line) => ({
    description: locale === 'fr' ? line.nameFr : line.nameEn,
    sku: line.sku,
    quantity: line.quantity,
    unitPrice: money(line.unitPriceCents),
    amount: money(line.subtotalCents),
  }));

  const taxRows: RenderedTaxRow[] = [];
  if (totals.taxGstCents > 0) taxRows.push({ label: s.gst, amount: money(totals.taxGstCents) });
  if (totals.taxHstCents > 0) taxRows.push({ label: s.hst, amount: money(totals.taxHstCents) });
  if (totals.taxQstCents > 0) taxRows.push({ label: s.qst, amount: money(totals.taxQstCents) });
  if (totals.taxPstCents > 0) taxRows.push({ label: s.pst, amount: money(totals.taxPstCents) });

  const isCredit = input.kind === 'CREDIT_NOTE';

  const paymentLine =
    order.cardBrand || order.cardLast4
      ? `${s.paidBy} ${order.cardBrand ?? s.card} •••• ${order.cardLast4 ?? '----'}`
      : null;

  return {
    locale,
    kind: input.kind,
    title: isCredit ? s.creditNoteTitle : s.invoiceTitle,
    strings: s,
    company,
    invoiceNumber: input.invoiceNumber,
    issuedAtLabel: fmtDate(input.issuedAt, locale),
    orderNumber: order.number,
    currency: order.currency,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    shipTo: formatAddressLines(order.shippingAddress),
    billTo: formatAddressLines(order.billingAddress ?? order.shippingAddress),
    lines,
    subtotal: money(totals.subtotalCents),
    discount: totals.discountCents > 0 ? money(totals.discountCents) : null,
    shipping: totals.shippingCents > 0 ? money(totals.shippingCents) : s.free,
    taxRows,
    total: money(totals.totalCents),
    totalLabel: isCredit ? s.creditTotal : s.total,
    paymentLine: isCredit ? null : paymentLine,
    creditNoteReason: isCredit ? (input.creditNoteReason ?? null) : null,
  };
}

/**
 * Rendu TEXTE du document — utilisé par les tests (assertions de contenu) et
 * comme repli lisible. Contient toutes les mentions obligatoires.
 */
export function renderInvoiceText(doc: InvoiceDocument): string {
  const s = doc.strings;
  const out: string[] = [];
  out.push(doc.company.raisonSociale);
  out.push([doc.company.adresse.line1, doc.company.adresse.line2].filter(Boolean).join(', '));
  out.push(
    `${doc.company.adresse.city}, ${doc.company.adresse.province} ${doc.company.adresse.postalCode}`,
  );
  out.push('');
  out.push(`${doc.title} — ${s.invoiceNo} ${doc.invoiceNumber}`);
  out.push(`${s.date} : ${doc.issuedAtLabel}`);
  out.push(`${s.orderNo} : ${doc.orderNumber}`);
  out.push('');
  out.push(`${s.registrations} :`);
  out.push(`  ${s.gstNo} : ${doc.company.numeroTps}`);
  out.push(`  ${s.qstNo} : ${doc.company.numeroTvq}`);
  out.push('');
  if (doc.billTo.length > 0) {
    out.push(`${s.billedTo} :`);
    for (const line of doc.billTo) out.push(`  ${line}`);
    out.push('');
  }
  if (doc.creditNoteReason) {
    out.push(`${s.reason} : ${doc.creditNoteReason}`);
    out.push('');
  }
  out.push(`${s.description} | ${s.qty} | ${s.unitPrice} | ${s.lineTotal}`);
  for (const line of doc.lines) {
    out.push(
      `${line.description} (${line.sku}) | ${line.quantity} | ${line.unitPrice} | ${line.amount}`,
    );
  }
  out.push('');
  out.push(`${s.subtotal} : ${doc.subtotal}`);
  if (doc.discount) out.push(`${s.discount} : −${doc.discount}`);
  out.push(`${s.shipping} : ${doc.shipping}`);
  for (const row of doc.taxRows) out.push(`${row.label} : ${row.amount}`);
  out.push(`${doc.totalLabel} : ${doc.total}`);
  if (doc.paymentLine) out.push(doc.paymentLine);
  out.push('');
  out.push(s.amountsIn);
  return out.join('\n');
}

export { STRINGS as INVOICE_STRINGS };
