import PDFDocument from 'pdfkit';
import { type InvoiceDocument } from './invoice-document';

/**
 * Rendu PDF d'une facture / note de crédit (tâche 12) à partir du modèle
 * bilingue résolu (invoice-document.ts). Gabarit maison sobre : en-tête
 * entreprise, numéros d'inscription, adresses, tableau des lignes,
 * ventilation des taxes, pied de page avec l'adresse physique.
 *
 * Police standard Helvetica (métriques AFM embarquées par pdfkit, encodage
 * WinAnsi) : les accents français sont pris en charge sans fichier de
 * police externe.
 */

const PAGE_MARGIN = 50;
const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#666666';
const COLOR_RULE = '#dddddd';
const COLOR_ACCENT = '#0f4c81';

export function renderInvoicePdf(doc: InvoiceDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'LETTER',
      margin: PAGE_MARGIN,
      info: {
        Title: `${doc.title} ${doc.invoiceNumber}`,
        Author: doc.company.raisonSociale,
      },
    });

    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    try {
      paint(pdf, doc);
      pdf.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

type Pdf = InstanceType<typeof PDFDocument>;

function paint(pdf: Pdf, doc: InvoiceDocument): void {
  const s = doc.strings;
  const left = PAGE_MARGIN;
  const right = pdf.page.width - PAGE_MARGIN;
  const contentWidth = right - left;

  /* ------------------------------ En-tête ------------------------------ */
  pdf
    .fillColor(COLOR_ACCENT)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(doc.company.raisonSociale, left, PAGE_MARGIN);

  pdf.fillColor(COLOR_MUTED).font('Helvetica').fontSize(9);
  const companyLines = [
    [doc.company.adresse.line1, doc.company.adresse.line2].filter(Boolean).join(', '),
    `${doc.company.adresse.city}, ${doc.company.adresse.province}  ${doc.company.adresse.postalCode}`,
    doc.company.courriel,
    doc.company.telephone ?? '',
  ].filter((line) => line.length > 0);
  pdf.text(companyLines.join('\n'), left, pdf.y + 4);

  // Bloc titre (aligné à droite).
  pdf
    .fillColor(COLOR_TEXT)
    .font('Helvetica-Bold')
    .fontSize(22)
    .text(doc.title, left, PAGE_MARGIN, { width: contentWidth, align: 'right' });
  pdf
    .font('Helvetica')
    .fontSize(10)
    .fillColor(COLOR_MUTED)
    .text(`${s.invoiceNo} ${doc.invoiceNumber}`, { width: contentWidth, align: 'right' })
    .text(`${s.date} : ${doc.issuedAtLabel}`, { width: contentWidth, align: 'right' })
    .text(`${s.orderNo} : ${doc.orderNumber}`, { width: contentWidth, align: 'right' });

  pdf.moveDown(1.5);
  rule(pdf, left, right);

  /* ------------------- Inscriptions + adresses (2 colonnes) ------------ */
  const blockTop = pdf.y + 10;
  const colWidth = (contentWidth - 20) / 2;

  // Colonne gauche : numéros d'inscription (mention obligatoire QC).
  pdf
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(COLOR_TEXT)
    .text(s.registrations, left, blockTop);
  pdf
    .font('Helvetica')
    .fontSize(9)
    .fillColor(COLOR_MUTED)
    .text(`${s.gstNo} : ${doc.company.numeroTps}`, { width: colWidth })
    .text(`${s.qstNo} : ${doc.company.numeroTvq}`, { width: colWidth });

  // Colonne droite : facturé à / livré à.
  const rightColX = left + colWidth + 20;
  pdf
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(COLOR_TEXT)
    .text(s.billedTo, rightColX, blockTop, {
      width: colWidth,
    });
  pdf
    .font('Helvetica')
    .fontSize(9)
    .fillColor(COLOR_MUTED)
    .text(doc.billTo.join('\n') || doc.customerEmail, rightColX, pdf.y, { width: colWidth });
  if (doc.shipTo.length > 0 && doc.shipTo.join() !== doc.billTo.join()) {
    pdf.moveDown(0.5);
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_TEXT).text(s.shipTo, rightColX, pdf.y, {
      width: colWidth,
    });
    pdf
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR_MUTED)
      .text(doc.shipTo.join('\n'), rightColX, pdf.y, { width: colWidth });
  }

  // Repartir sous le plus bas des deux colonnes.
  pdf.x = left;
  pdf.y = Math.max(pdf.y, blockTop) + 20;

  if (doc.creditNoteReason) {
    pdf
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(COLOR_MUTED)
      .text(`${s.creditNotice}  ${s.reason} : ${doc.creditNoteReason}`, left, pdf.y, {
        width: contentWidth,
      });
    pdf.moveDown(1);
  }

  /* --------------------------- Tableau des lignes ---------------------- */
  const cols = {
    desc: left,
    qty: left + contentWidth * 0.6,
    unit: left + contentWidth * 0.72,
    amount: left + contentWidth * 0.86,
  };
  const amountWidth = right - cols.amount;
  const unitWidth = cols.amount - cols.unit;
  const qtyWidth = cols.unit - cols.qty;

  const header = pdf.y + 6;
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_TEXT);
  pdf.text(s.description, cols.desc, header, { width: cols.qty - cols.desc - 6 });
  pdf.text(s.qty, cols.qty, header, { width: qtyWidth, align: 'right' });
  pdf.text(s.unitPrice, cols.unit, header, { width: unitWidth, align: 'right' });
  pdf.text(s.lineTotal, cols.amount, header, { width: amountWidth, align: 'right' });
  pdf.moveDown(0.5);
  rule(pdf, left, right);

  pdf.font('Helvetica').fontSize(9).fillColor(COLOR_TEXT);
  for (const line of doc.lines) {
    const rowTop = pdf.y + 6;
    const descHeight = pdf.heightOfString(`${line.description}\n${line.sku}`, {
      width: cols.qty - cols.desc - 6,
    });
    pdf.fillColor(COLOR_TEXT).text(line.description, cols.desc, rowTop, {
      width: cols.qty - cols.desc - 6,
    });
    pdf
      .fillColor(COLOR_MUTED)
      .fontSize(8)
      .text(line.sku, cols.desc, pdf.y, {
        width: cols.qty - cols.desc - 6,
      });
    pdf.fontSize(9).fillColor(COLOR_TEXT);
    pdf.text(String(line.quantity), cols.qty, rowTop, { width: qtyWidth, align: 'right' });
    pdf.text(line.unitPrice, cols.unit, rowTop, { width: unitWidth, align: 'right' });
    pdf.text(line.amount, cols.amount, rowTop, { width: amountWidth, align: 'right' });
    pdf.y = Math.max(pdf.y, rowTop + descHeight);
    pdf.moveDown(0.4);
  }

  rule(pdf, left, right);

  /* ------------------------------ Totaux ------------------------------- */
  const totalsLabelX = left + contentWidth * 0.55;
  const totalsLabelWidth = cols.amount - totalsLabelX - 6;
  const totalRow = (label: string, value: string, bold = false): void => {
    const y = pdf.y + 4;
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9);
    pdf.fillColor(bold ? COLOR_TEXT : COLOR_MUTED);
    pdf.text(label, totalsLabelX, y, { width: totalsLabelWidth, align: 'right' });
    pdf.fillColor(COLOR_TEXT).text(value, cols.amount, y, { width: amountWidth, align: 'right' });
    pdf.moveDown(0.2);
  };

  pdf.moveDown(0.3);
  totalRow(s.subtotal, doc.subtotal);
  if (doc.discount) totalRow(s.discount, `−${doc.discount}`);
  totalRow(s.shipping, doc.shipping);
  for (const row of doc.taxRows) totalRow(row.label, row.amount);
  pdf.moveDown(0.2);
  totalRow(doc.totalLabel, doc.total, true);
  if (doc.paymentLine) {
    pdf.moveDown(0.4);
    pdf
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR_MUTED)
      .text(doc.paymentLine, totalsLabelX, pdf.y, {
        width: cols.amount + amountWidth - totalsLabelX,
        align: 'right',
      });
  }

  /* ------------------------------ Pied ---------------------------------- */
  const footerY = pdf.page.height - PAGE_MARGIN - 40;
  rule(pdf, left, right, footerY);
  pdf
    .font('Helvetica')
    .fontSize(8)
    .fillColor(COLOR_MUTED)
    .text(s.thanks, left, footerY + 6, { width: contentWidth, align: 'center' })
    .text(
      `${doc.company.raisonSociale} — ${doc.company.adresse.line1}, ${doc.company.adresse.city}, ${doc.company.adresse.province} ${doc.company.adresse.postalCode}`,
      { width: contentWidth, align: 'center' },
    )
    .text(s.amountsIn, { width: contentWidth, align: 'center' });
}

function rule(pdf: Pdf, left: number, right: number, y?: number): void {
  const lineY = y ?? pdf.y;
  pdf.strokeColor(COLOR_RULE).lineWidth(0.5).moveTo(left, lineY).lineTo(right, lineY).stroke();
  if (y === undefined) pdf.y = lineY + 2;
}
