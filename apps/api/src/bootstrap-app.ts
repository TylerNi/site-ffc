import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { type Env, parseCorsOrigins } from './config/env';

/**
 * Configuration HTTP commune à la production (main.ts) et aux tests e2e :
 * mêmes middlewares, mêmes pipes — les tests exercent l'app réelle.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService<Env, true>);

  // Derrière Cloudflare + ALB en production : nécessaire pour que le rate
  // limiting par IP voie l'adresse réelle du client, pas celle du proxy.
  const trustProxyHops = config.get('TRUST_PROXY_HOPS', { infer: true });
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

  app.setGlobalPrefix('v1');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: parseCorsOrigins(config.get('API_CORS_ORIGINS', { infer: true })),
    // Le refresh token du web voyage dans un cookie httpOnly.
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // les champs inconnus sont silencieusement retirés
      transform: true,
    }),
  );
}
