import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Invoice, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database';
import { allocateInvoiceNumber, invoiceSeries } from '../../../database/invoice-number';
import { CompanyInfoService } from './company-info';
import {
  type AddressSnapshot,
  buildInvoiceDocument,
  type InvoiceLineInput,
  type InvoiceTotals,
} from './invoice-document';
import { renderInvoicePdf } from './invoice-pdf.renderer';
import { INVOICE_STORAGE, type InvoiceStorage } from './invoice-storage';
import { OrderMailService } from './order-mail.service';

/** Instantané financier d'une note de crédit (montants remboursés, en cents). */
export interface CreditNoteSnapshot extends InvoiceTotals {
  reason: string | null;
  /** Lignes remboursées (remboursement par lignes) — sinon totaux seuls. */
  lines?: InvoiceLineInput[];
}

/**
 * Cycle de vie documentaire des factures (tâche 12).
 *
 * FACTURE : générée à la commande payée (une par commande, garantie par
 * l'index unique partiel `invoices_one_invoice_per_order`). Numéro alloué
 * SANS TROU dans la transaction d'insertion (fonction SQL de la tâche 04).
 * PDF bilingue rendu selon la locale du client, déposé dans le bucket privé
 * `invoices`, puis courriel de confirmation (avec lien de facture) mis en file.
 *
 * NOTE DE CRÉDIT : générée à chaque remboursement (une par remboursement,
 * garantie par l'unicité de `invoices.refund_id`), série CRN distincte.
 *
 * Idempotence : rejouer la génération ne crée jamais de doublon ni de trou —
 * l'existence est vérifiée, et le PDF est (re)produit s'il manque (reprise
 * après un crash entre le commit et l'envoi S3).
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyInfoService,
    private readonly orderMail: OrderMailService,
    @Inject(INVOICE_STORAGE) private readonly storage: InvoiceStorage,
  ) {}

  /* ------------------------------ Facture ------------------------------ */

  /** Génère (ou reprend) la facture d'une commande payée, puis notifie. */
  async generateForOrder(orderId: string): Promise<Invoice | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return null;
    // Aucune facture pour une commande non réglée : PENDING (pas payée) ou
    // CANCELLED avant paiement. Une commande CANCELLED APRÈS paiement (donc
    // remboursée) conserve sa facture + une note de crédit.
    if (order.status === 'PENDING') return null;

    let invoice = await this.prisma.invoice.findFirst({
      where: { orderId, kind: 'INVOICE' },
    });

    if (!invoice) {
      const issuedAt = order.paidAt ?? new Date();
      const series = invoiceSeries('INVOICE', issuedAt);
      try {
        invoice = await this.prisma.$transaction(async (tx) => {
          const allocated = await allocateInvoiceNumber(tx, series);
          return tx.invoice.create({
            data: {
              orderId,
              kind: 'INVOICE',
              status: 'ISSUED',
              series: allocated.series,
              sequence: allocated.sequence,
              number: allocated.number,
              currency: order.currency,
              subtotalCents: order.subtotalCents,
              discountCents: order.discountCents,
              shippingCents: order.shippingCents,
              taxGstCents: order.taxGstCents,
              taxQstCents: order.taxQstCents,
              taxHstCents: order.taxHstCents,
              taxPstCents: order.taxPstCents,
              totalCents: order.totalCents,
              issuedAt,
            },
          });
        });
      } catch (error) {
        // Course : un autre worker a créé la facture (index unique partiel).
        // On récupère la sienne — pas de doublon, pas de trou (le numéro
        // alloué par la transaction perdante est restitué au ROLLBACK).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          invoice = await this.prisma.invoice.findFirstOrThrow({
            where: { orderId, kind: 'INVOICE' },
          });
        } else {
          throw error;
        }
      }
    }

    if (!invoice.pdfKey) {
      await this.renderAndStore(invoice.id);
    }

    // Confirmation (idempotente) — lien vers la facture qu'on vient de produire.
    await this.orderMail.sendConfirmation(orderId, invoice.id);
    return invoice;
  }

  /* --------------------------- Note de crédit -------------------------- */

  /** Génère la note de crédit d'un remboursement (idempotente par refundId). */
  async generateCreditNote(
    refundId: string,
    orderId: string,
    snapshot: CreditNoteSnapshot,
  ): Promise<Invoice> {
    const existing = await this.prisma.invoice.findUnique({ where: { refundId } });
    if (existing) {
      if (!existing.pdfKey) await this.renderAndStore(existing.id);
      return existing;
    }

    const issuedAt = new Date();
    const series = invoiceSeries('CREDIT_NOTE', issuedAt);
    let invoice: Invoice;
    try {
      invoice = await this.prisma.$transaction(async (tx) => {
        const allocated = await allocateInvoiceNumber(tx, series);
        return tx.invoice.create({
          data: {
            orderId,
            refundId,
            kind: 'CREDIT_NOTE',
            status: 'ISSUED',
            series: allocated.series,
            sequence: allocated.sequence,
            number: allocated.number,
            currency: 'CAD',
            subtotalCents: snapshot.subtotalCents,
            discountCents: snapshot.discountCents,
            shippingCents: snapshot.shippingCents,
            taxGstCents: snapshot.taxGstCents,
            taxQstCents: snapshot.taxQstCents,
            taxHstCents: snapshot.taxHstCents,
            taxPstCents: snapshot.taxPstCents,
            totalCents: snapshot.totalCents,
            issuedAt,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { refundId } });
        if (!invoice.pdfKey) await this.renderAndStore(invoice.id, snapshot);
        return invoice;
      }
      throw error;
    }

    await this.renderAndStore(invoice.id, snapshot);
    return invoice;
  }

  /* ------------------------------ Octets ------------------------------- */

  /** Relit les octets du PDF (endpoint de téléchargement / lien signé). */
  async fetchPdf(invoiceId: string): Promise<{ number: string; body: Buffer } | null> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return null;
    if (!invoice.pdfKey) {
      // Génération asynchrone pas encore terminée — reprise à la volée.
      await this.renderAndStore(invoiceId);
      const refreshed = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (!refreshed.pdfKey) return null;
      const body = await this.storage.fetch(refreshed.pdfKey);
      return body ? { number: refreshed.number, body } : null;
    }
    const body = await this.storage.fetch(invoice.pdfKey);
    return body ? { number: invoice.number, body } : null;
  }

  /* ------------------------------ Interne ------------------------------ */

  /** Rend le PDF d'une facture/note existante et l'enregistre (clé S3). */
  private async renderAndStore(
    invoiceId: string,
    creditSnapshot?: CreditNoteSnapshot,
  ): Promise<void> {
    const invoice = await this.prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: {
        order: { include: { items: true, user: { select: { email: true } } } },
      },
    });
    const order = invoice.order;
    const company = await this.company.billing();

    const lines: InvoiceLineInput[] =
      invoice.kind === 'CREDIT_NOTE'
        ? (creditSnapshot?.lines ?? [])
        : order.items.map((item) => ({
            sku: item.sku,
            nameFr: item.nameFr,
            nameEn: item.nameEn,
            nominalLabel: item.nominalLabel,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            discountCents: item.discountCents,
            subtotalCents: item.subtotalCents,
            taxCents: item.taxCents,
            totalCents: item.totalCents,
          }));

    const document = buildInvoiceDocument({
      locale: order.locale,
      kind: invoice.kind,
      invoiceNumber: invoice.number,
      issuedAt: invoice.issuedAt,
      company,
      order: {
        number: order.number,
        placedAt: order.placedAt,
        customerName: customerNameFrom(order.billingAddress ?? order.shippingAddress),
        customerEmail: order.guestEmail ?? order.user?.email ?? '',
        shippingAddress: order.shippingAddress as AddressSnapshot | null,
        billingAddress: order.billingAddress as AddressSnapshot | null,
        currency: order.currency,
      },
      lines,
      totals: {
        subtotalCents: invoice.subtotalCents,
        discountCents: invoice.discountCents,
        shippingCents: invoice.shippingCents,
        taxGstCents: invoice.taxGstCents,
        taxQstCents: invoice.taxQstCents,
        taxHstCents: invoice.taxHstCents,
        taxPstCents: invoice.taxPstCents,
        totalCents: invoice.totalCents,
      },
      creditNoteReason: creditSnapshot?.reason ?? null,
    });

    const pdf = await renderInvoicePdf(document);
    const key = `invoices/${invoice.series}/${invoice.number}.pdf`;
    await this.storage.put(key, pdf);
    await this.prisma.invoice.update({ where: { id: invoice.id }, data: { pdfKey: key } });
    this.logger.log(`Facture ${invoice.number} rendue (${pdf.length} octets) → ${key}`);
  }
}

function customerNameFrom(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const a = address as { firstName?: unknown; lastName?: unknown };
  const name = [a.firstName, a.lastName]
    .filter((x) => typeof x === 'string' && x)
    .join(' ')
    .trim();
  return name.length > 0 ? name : null;
}
