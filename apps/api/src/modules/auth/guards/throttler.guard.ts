import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard global avec une échappatoire RÉSERVÉE AUX TESTS
 * automatisés (AUTH_THROTTLE_DISABLED=1) : les suites e2e enchaînent des
 * dizaines de logins depuis 127.0.0.1 et testent le rate limiting dans un
 * fichier dédié. En production, la variable est absente (défaut « 0 »).
 *
 * (Le skipIf de @nestjs/throttler ne suffit pas : les routes qui portent
 * un @Throttle() de resserrage le contournent.)
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.AUTH_THROTTLE_DISABLED === '1') return true;
    return super.canActivate(context);
  }
}
