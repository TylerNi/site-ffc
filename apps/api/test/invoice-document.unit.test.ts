import { describe, expect, it } from 'vitest';
import { type CompanyBillingInfo } from '../src/modules/orders/invoices/company-info';
import {
  buildInvoiceDocument,
  type InvoiceDocumentInput,
  renderInvoiceText,
} from '../src/modules/orders/invoices/invoice-document';
import { renderInvoicePdf } from '../src/modules/orders/invoices/invoice-pdf.renderer';

const COMPANY: CompanyBillingInfo = {
  raisonSociale: 'Filtration Montréal inc.',
  adresse: {
    line1: '1234, rue Sainte-Catherine Est',
    line2: 'Bureau 200',
    city: 'Montréal',
    province: 'QC',
    postalCode: 'H2L 2G8',
    country: 'CA',
  },
  courriel: 'facturation@filtrationmontreal.com',
  telephone: '+1 514-555-0142',
  numeroTps: '123456789 RT0001',
  numeroTvq: '1234567890 TQ0001',
};

function qcInput(overrides: Partial<InvoiceDocumentInput> = {}): InvoiceDocumentInput {
  return {
    locale: 'fr',
    kind: 'INVOICE',
    invoiceNumber: 'INV-2026-000042',
    issuedAt: new Date('2026-07-08T15:00:00Z'),
    company: COMPANY,
    order: {
      number: 'FFC-100042',
      placedAt: new Date('2026-07-08T14:59:00Z'),
      customerName: 'Marie Tremblay',
      customerEmail: 'marie@example.com',
      shippingAddress: {
        firstName: 'Marie',
        lastName: 'Tremblay',
        line1: '1 rue Test',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H2L 2G8',
        country: 'CA',
      },
      billingAddress: null,
      currency: 'CAD',
      cardBrand: 'visa',
      cardLast4: '4242',
    },
    lines: [
      {
        sku: 'TST-1',
        nameFr: 'Filtre à air 16x25x1',
        nameEn: 'Air filter 16x25x1',
        nominalLabel: '16x25x1',
        quantity: 2,
        unitPriceCents: 2000,
        discountCents: 0,
        subtotalCents: 4000,
        taxCents: 599,
        totalCents: 4599,
      },
    ],
    totals: {
      subtotalCents: 4000,
      discountCents: 0,
      shippingCents: 0,
      taxGstCents: 200,
      taxQstCents: 399,
      taxHstCents: 0,
      taxPstCents: 0,
      totalCents: 4599,
    },
    ...overrides,
  };
}

describe('document de facture (tâche 12)', () => {
  it('facture QC en français : mentions, TPS/TVQ ventilées, numéros d’inscription', () => {
    const doc = buildInvoiceDocument(qcInput());
    const text = renderInvoiceText(doc);

    expect(doc.title).toBe('FACTURE');
    expect(doc.orderNumber).toBe('FFC-100042');
    // Ventilation des deux taxes québécoises.
    const labels = doc.taxRows.map((r) => r.label);
    expect(labels.some((l) => l.startsWith('TPS'))).toBe(true);
    expect(labels.some((l) => l.startsWith('TVQ'))).toBe(true);
    // Numéros d'inscription affichés.
    expect(text).toContain('123456789 RT0001');
    expect(text).toContain('1234567890 TQ0001');
    expect(text).toContain('No TPS/TVH');
    expect(text).toContain('No TVQ');
    // Montants formatés en français canadien.
    expect(doc.total).toContain('$');
    expect(text).toContain('FACTURE');
  });

  it('facture en anglais : titre et libellés localisés', () => {
    const doc = buildInvoiceDocument(qcInput({ locale: 'en' }));
    expect(doc.title).toBe('INVOICE');
    expect(doc.taxRows.some((r) => r.label.startsWith('GST'))).toBe(true);
    expect(doc.taxRows.some((r) => r.label.startsWith('QST'))).toBe(true);
  });

  it('note de crédit : titre et motif', () => {
    const fr = buildInvoiceDocument(
      qcInput({ kind: 'CREDIT_NOTE', creditNoteReason: 'Retour client' }),
    );
    expect(fr.title).toBe('NOTE DE CRÉDIT');
    expect(fr.creditNoteReason).toBe('Retour client');
    const en = buildInvoiceDocument(qcInput({ locale: 'en', kind: 'CREDIT_NOTE' }));
    expect(en.title).toBe('CREDIT NOTE');
  });

  it('rend un PDF valide (octets %PDF)', async () => {
    const doc = buildInvoiceDocument(qcInput());
    const pdf = await renderInvoicePdf(doc);
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
