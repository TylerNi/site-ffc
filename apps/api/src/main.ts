import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { type Env, parseCorsOrigins } from './config/env';
import { createOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Env, true>);

  app.setGlobalPrefix('v1');
  app.enableCors({
    origin: parseCorsOrigins(config.get('API_CORS_ORIGINS', { infer: true })),
  });

  const document = createOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document);

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`FFC API démarrée : http://localhost:${port}/v1/health · docs : /docs`);
}

void bootstrap();
