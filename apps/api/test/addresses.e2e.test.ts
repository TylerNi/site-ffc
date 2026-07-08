import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  bearer,
  createTestApp,
  login,
  registerAndVerify,
  uniqueEmail,
} from './auth-helpers';

/**
 * Carnet d'adresses du compte (tâche 11) : validation CA/US identique au
 * checkout, normalisation des codes postaux, gestion des défauts.
 */
describe('compte — carnet d’adresses', () => {
  let ctx: AuthTestContext;
  let accessToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const email = uniqueEmail('carnet');
    await registerAndVerify(ctx, email);
    accessToken = (await login(ctx, email)).accessToken!;
  });
  afterAll(async () => {
    await ctx.close();
  });

  const VALID = {
    firstName: 'Marie',
    lastName: 'Tremblay',
    line1: '1234, rue Sainte-Catherine Est',
    city: 'Montréal',
    province: 'QC',
    postalCode: 'h2l2g8',
    country: 'CA',
    label: 'Maison',
  };

  it('exige une session : 401 sans Bearer', async () => {
    await ctx.http().get('/v1/me/addresses').expect(401);
  });

  it('crée, liste, modifie et supprime — code postal NORMALISÉ', async () => {
    const created = await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .send(VALID)
      .expect(201);
    expect(created.body.postalCode).toBe('H2L 2G8'); // normalisé
    expect(created.body.isDefaultShipping).toBe(true); // première adresse = défaut

    const list = await ctx
      .http()
      .get('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .expect(200);
    expect(list.body.addresses).toHaveLength(1);

    const updated = await ctx
      .http()
      .put(`/v1/me/addresses/${created.body.id}`)
      .set('Authorization', bearer(accessToken))
      .send({ ...VALID, label: 'Chalet', city: 'Sainte-Adèle', postalCode: 'J8B 1A1' })
      .expect(200);
    expect(updated.body.label).toBe('Chalet');
    expect(updated.body.postalCode).toBe('J8B 1A1');

    await ctx
      .http()
      .delete(`/v1/me/addresses/${created.body.id}`)
      .set('Authorization', bearer(accessToken))
      .expect(204);
  });

  it('refuse les formats postaux invalides (CA et US)', async () => {
    await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .send({ ...VALID, postalCode: '12345' }) // ZIP sur pays CA
      .expect(400);
    await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .send({ ...VALID, country: 'US', province: 'NY', postalCode: 'H2L 2G8' })
      .expect(400);
    await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .send({ ...VALID, country: 'FR' }) // pays hors CA/US
      .expect(400);
  });

  it('poser un défaut retire l’ancien (un seul défaut par usage)', async () => {
    const first = await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .send({ ...VALID, isDefaultShipping: true })
      .expect(201);
    const second = await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .send({ ...VALID, label: 'Bureau', line1: '500 boul. Test', isDefaultShipping: true })
      .expect(201);

    const list = await ctx
      .http()
      .get('/v1/me/addresses')
      .set('Authorization', bearer(accessToken))
      .expect(200);
    const defaults = list.body.addresses.filter(
      (address: { isDefaultShipping: boolean }) => address.isDefaultShipping,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.body.id);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it('impossible de toucher l’adresse d’un autre compte', async () => {
    const otherEmail = uniqueEmail('carnet-autre');
    await registerAndVerify(ctx, otherEmail);
    const other = await login(ctx, otherEmail);
    const address = await ctx
      .http()
      .post('/v1/me/addresses')
      .set('Authorization', bearer(other.accessToken))
      .send(VALID)
      .expect(201);

    await ctx
      .http()
      .put(`/v1/me/addresses/${address.body.id}`)
      .set('Authorization', bearer(accessToken))
      .send(VALID)
      .expect(404);
    await ctx
      .http()
      .delete(`/v1/me/addresses/${address.body.id}`)
      .set('Authorization', bearer(accessToken))
      .expect(404);
  });
});
