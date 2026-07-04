import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';

/**
 * Endpoints d'administration — socle posé en tâche 05 (accès verrouillé
 * par rôle + MFA obligatoire), étoffé à partir de la tâche 09 (RBAC fin).
 */
@Module({
  controllers: [AdminController],
})
export class AdminModule {}
