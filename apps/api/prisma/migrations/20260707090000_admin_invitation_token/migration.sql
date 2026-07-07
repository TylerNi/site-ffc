-- Tâche 09 : invitation d'un compte du personnel à l'admin (jeton à usage
-- unique dédié). Nouvelle valeur de l'enum des finalités de jetons.
-- AlterEnum
ALTER TYPE "one_time_token_purpose" ADD VALUE 'ADMIN_INVITATION';
