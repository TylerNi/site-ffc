import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** Journal d'audit — global : tous les modules consignent sans réimporter. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
