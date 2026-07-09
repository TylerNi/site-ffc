import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer } from './auth-helpers';
import { createCheckoutTestApp, type CheckoutTestContext } from './checkout-helpers';
import { paidOrderForUser } from './order-helpers';
import { InvoiceDownloadTokenService } from '../src/modules/orders/invoices/invoice-download-token';

describe('factures PDF (tâche 12)', () => {
  let ctx: CheckoutTestContext;
  let tokens: InvoiceDownloadTokenService;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
    tokens = ctx.app.get(InvoiceDownloadTokenService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('facture générée à la commande payée : QC, ventilation TPS/TVQ, numéro INV', async () => {
    const paid = await paidOrderForUser(ctx, { province: 'QC', priceCents: 5_000 });

    const invoice = await ctx.prisma.invoice.findFirstOrThrow({
      where: { orderId: paid.order.id, kind: 'INVOICE' },
    });
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(invoice.pdfKey).toBeTruthy();
    // Montants figés = ceux de la commande QC (TPS + TVQ ventilées).
    expect(invoice.taxGstCents).toBe(paid.order.taxGstCents);
    expect(invoice.taxQstCents).toBe(paid.order.taxQstCents);
    expect(invoice.taxGstCents).toBeGreaterThan(0);
    expect(invoice.taxQstCents).toBeGreaterThan(0);
    expect(invoice.totalCents).toBe(paid.order.totalCents);
  });

  it('une seule facture par commande, même si la génération est rejouée', async () => {
    const paid = await paidOrderForUser(ctx);
    const invoiceService = ctx.app.get(
      (await import('../src/modules/orders/invoices/invoice.service')).InvoiceService,
    );
    await invoiceService.generateForOrder(paid.order.id);
    await invoiceService.generateForOrder(paid.order.id);
    const invoices = await ctx.prisma.invoice.findMany({
      where: { orderId: paid.order.id, kind: 'INVOICE' },
    });
    expect(invoices).toHaveLength(1);
  });

  it('téléchargement authentifié (« Mes commandes ») : PDF valide', async () => {
    const paid = await paidOrderForUser(ctx);
    const res = await ctx
      .http()
      .get(`/v1/me/orders/${paid.order.id}/invoice`)
      .set('Authorization', bearer(paid.accessToken))
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(res.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('téléchargement par lien signé (courriel) : valide ; jeton faux → 401', async () => {
    const paid = await paidOrderForUser(ctx);
    const invoice = await ctx.prisma.invoice.findFirstOrThrow({
      where: { orderId: paid.order.id, kind: 'INVOICE' },
    });

    const token = tokens.sign(invoice.id);
    await ctx.http().get(`/v1/invoices/${invoice.id}/download?token=${token}`).expect(200);

    // Jeton signé pour une AUTRE facture → refus (ne vise pas cette facture).
    const otherToken = tokens.sign('00000000-0000-4000-8000-000000000000');
    await ctx.http().get(`/v1/invoices/${invoice.id}/download?token=${otherToken}`).expect(401);

    // Jeton absent / bidon → refus.
    await ctx.http().get(`/v1/invoices/${invoice.id}/download?token=nawak`).expect(401);
    await ctx.http().get(`/v1/invoices/${invoice.id}/download`).expect(401);
  });

  it('un autre compte ne télécharge pas ma facture (404)', async () => {
    const paid = await paidOrderForUser(ctx);
    const { createUserInDb, login } = await import('./auth-helpers');
    const other = await createUserInDb(ctx);
    const auth = await login(ctx, other.email);
    await ctx
      .http()
      .get(`/v1/me/orders/${paid.order.id}/invoice`)
      .set('Authorization', bearer(auth.accessToken))
      .expect(404);
  });
});
