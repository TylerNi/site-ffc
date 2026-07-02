import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { createOpenApiDocument } from '../openapi';

/**
 * Émet `apps/api/openapi.json` sans démarrer de serveur HTTP.
 * Consommé par `packages/api-client` (`pnpm generate:client` à la racine).
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1');
  await app.init();

  const document = createOpenApiDocument(app);
  const outPath = resolve(__dirname, '../../openapi.json');
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  console.log(`OpenAPI écrit : ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
