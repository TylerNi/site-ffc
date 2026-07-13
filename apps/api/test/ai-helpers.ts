import sharp from 'sharp';
import { type AiPhotoStorage, InMemoryAiPhotoStorage } from '../src/modules/ai/ai-photo-storage';
import { AiProcessorService } from '../src/modules/ai/ai-processor.service';
import { AiPurgeService } from '../src/modules/ai/ai-purge.service';
import { AnthropicVisionProvider } from '../src/modules/ai/ai-vision/anthropic.provider';
import { LogVisionProvider } from '../src/modules/ai/ai-vision/log.provider';
import {
  type AuthTestContext,
  bearer,
  createTestApp,
  login,
  registerAndVerify,
  uniqueEmail,
} from './auth-helpers';

/**
 * Aides partagées des tests du pipeline de vision IA (tâche 17).
 *
 * Le fournisseur de vision et le stockage des photos sont SUBSTITUÉS dans le
 * module de test (pattern FakeStripe) plutôt que pilotés par variables
 * d'environnement : @nestjs/config fige la validation au premier import du
 * module — les valeurs à défaut zod (AI_VISION_DRIVER…) ne sont plus
 * modifiables via process.env ensuite. Les tests restent ainsi hermétiques,
 * quel que soit le contenu du .env local (clés API réelles comprises).
 */

export interface AiTestContext extends AuthTestContext {
  storage: AiPhotoStorage;
  vision: LogVisionProvider;
  processor: AiProcessorService;
  purge: AiPurgeService;
}

export interface CreateAiTestAppOptions {
  /** true = fournisseur RÉEL sans clé API (test du 503) au lieu du driver log. */
  unconfiguredProvider?: boolean;
}

export async function createAiTestApp(
  options: CreateAiTestAppOptions = {},
): Promise<AiTestContext> {
  const vision = new LogVisionProvider();
  const storage = new InMemoryAiPhotoStorage('http://localhost:4000');
  const ctx = await createTestApp({
    visionProvider: options.unconfiguredProvider
      ? new AnthropicVisionProvider(undefined, 'claude-opus-4-8')
      : vision,
    aiPhotoStorage: storage,
  });
  return {
    ...ctx,
    storage,
    vision,
    processor: ctx.app.get(AiProcessorService),
    purge: ctx.app.get(AiPurgeService),
  };
}

/** Compte client vérifié + jeton Bearer prêt à l'emploi. */
export async function customer(
  ctx: AuthTestContext,
): Promise<{ userId: string; email: string; authorization: string }> {
  const email = uniqueEmail('ia');
  await registerAndVerify(ctx, email);
  const session = await login(ctx, email);
  return {
    userId: session.user!.id,
    email,
    authorization: bearer(session.accessToken),
  };
}

/* ------------------------------- Images -------------------------------- */

/** Vraie photo JPEG (dégradé — sharp), optionnellement avec EXIF GPS. */
export async function makeJpeg(options: { gps?: boolean } = {}): Promise<Buffer> {
  let pipeline = sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 180, g: 120, b: 40 } },
  }).jpeg({ quality: 90 });
  if (options.gps) {
    pipeline = pipeline.withExif({
      IFD0: { Make: 'Apple', Model: 'iPhone 15' },
      // IFD3 = bloc GPS de l'EXIF (position du domicile du client — à purger).
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '45/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '73/1 34/1 0/1',
      },
    });
  }
  return pipeline.toBuffer();
}

/** Un « exécutable » renommé .jpg : octets MZ (PE Windows) — doit être rejeté. */
export function makeExe(): Buffer {
  const bytes = Buffer.alloc(4096, 0x90);
  bytes.write('MZ', 0, 'latin1');
  return bytes;
}

/** 11 Mo avec une vraie signature JPEG : seul le contrôle de taille doit le stopper. */
export function makeOversized(): Buffer {
  const bytes = Buffer.alloc(11 * 1024 * 1024, 0x00);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

/* -------------------------------- Flux --------------------------------- */

export interface CreatedIdentification {
  id: string;
  key: string;
  upload: { url: string; fields: Record<string, string>; maxBytes: number };
}

/** POST /v1/ai/identifications — retourne l'id et la clé de téléversement. */
export async function createIdentification(
  ctx: AiTestContext,
  authorization: string,
  mode: 'EQUIPMENT_LABEL' | 'FILTER_FRAME',
  expectStatus = 201,
): Promise<CreatedIdentification> {
  const response = await ctx
    .http()
    .post('/v1/ai/identifications')
    .set('Authorization', authorization)
    .send({ mode, consent: true })
    .expect(expectStatus);
  const body = response.body as {
    identification: { id: string };
    upload: { url: string; fields: Record<string, string>; maxBytes: number };
  };
  return { id: body.identification.id, key: body.upload.fields.key!, upload: body.upload };
}

/** Simule le POST présigné du client (écriture directe dans le stockage mémoire). */
export async function uploadPhoto(ctx: AiTestContext, key: string, bytes: Buffer): Promise<void> {
  await ctx.storage.put(key, bytes, 'image/jpeg');
}

/** POST …/:id/submit — en test, l'analyse inline est terminée au retour. */
export async function submitIdentification(
  ctx: AiTestContext,
  authorization: string,
  id: string,
  expectStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await ctx
    .http()
    .post(`/v1/ai/identifications/${id}/submit`)
    .set('Authorization', authorization)
    .expect(expectStatus);
  return response.body as Record<string, unknown>;
}

export async function getIdentification(
  ctx: AiTestContext,
  authorization: string,
  id: string,
  expectStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await ctx
    .http()
    .get(`/v1/ai/identifications/${id}`)
    .set('Authorization', authorization)
    .expect(expectStatus);
  return response.body as Record<string, unknown>;
}

/** Parcours complet : création → téléversement → soumission. */
export async function runFullFlow(
  ctx: AiTestContext,
  authorization: string,
  mode: 'EQUIPMENT_LABEL' | 'FILTER_FRAME',
  photo?: Buffer,
): Promise<{ id: string; body: Record<string, unknown> }> {
  const created = await createIdentification(ctx, authorization, mode);
  await uploadPhoto(ctx, created.key, photo ?? (await makeJpeg()));
  const body = await submitIdentification(ctx, authorization, created.id);
  return { id: created.id, body };
}
