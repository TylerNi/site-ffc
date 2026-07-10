import { Global, Module } from '@nestjs/common';
import { PushService } from './push.service';

/**
 * Notifications push Expo (tâche 14) — global, comme le courriel : les
 * jalons de suivi (tâche 14) et les rappels de réachat (tâche 20) poussent
 * par ici. Driver `log` en dev/test, `expo` en production.
 */
@Global()
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
