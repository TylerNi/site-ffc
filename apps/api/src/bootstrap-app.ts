import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
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
  // Relais de téléversement DEV/TEST (tâches 10 et 17) : les fichiers voyagent
  // en base64 dans du JSON — la limite par défaut (100 ko) est relevée sur ces
  // seuls chemins (10 Mo binaires ≈ 13,4 Mo en base64). Le parseur JSON global
  // de Nest voit ensuite le corps déjà analysé et n'y retouche pas. En
  // production, ces relais répondent 404 et le client parle directement à S3.
  // L'enveloppe nommée est OBLIGATOIRE : Nest saute son parseur global s'il
  // repère une couche déjà nommée « jsonParser » dans la pile Express.
  const largeJson = json({ limit: '16mb' });
  app.use(
    ['/v1/dev/uploads', '/v1/ai/dev-uploads'],
    function devUploadsJsonLimit(req: Request, res: Response, next: NextFunction) {
      largeJson(req, res, next);
    },
  );
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
