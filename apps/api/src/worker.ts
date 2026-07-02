import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Point d'entrée du service « workers » (ECS Fargate).
 *
 * Même image que l'API, commande différente (`node dist/worker.js`). Démarre un
 * contexte Nest autonome, *sans* serveur HTTP, destiné à héberger les files
 * BullMQ (tâches 14 et 20). Pour l'instant il démarre proprement, journalise sa
 * disponibilité et attend les signaux — de sorte que le service ECS `workers`
 * soit déployable dès la tâche 03.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[workers] Signal ${signal} reçu — arrêt en cours…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[workers] Contexte worker démarré. Files BullMQ à venir (tâches 14, 20).');
}

void bootstrap();
