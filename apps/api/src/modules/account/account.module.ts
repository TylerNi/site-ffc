import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AddressesController } from './addresses.controller';

/** Compte client — droits Loi 25 (export, suppression) + carnet d'adresses. */
@Module({
  imports: [AuthModule],
  controllers: [AccountController, AddressesController],
  providers: [AccountService],
})
export class AccountModule {}
