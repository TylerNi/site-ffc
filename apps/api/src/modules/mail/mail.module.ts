import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Courriels transactionnels (SES en production, console en dev/test). */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
