import { Global, Module } from '@nestjs/common';
import { MailQueueService } from './mail-queue.service';
import { MailService } from './mail.service';

/** Courriels transactionnels (SES en production, console en dev/test). */
@Global()
@Module({
  providers: [MailService, MailQueueService],
  exports: [MailService, MailQueueService],
})
export class MailModule {}
