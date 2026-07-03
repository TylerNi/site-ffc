/**
 * Outil opérateur — anonymisation d'un compte (Loi 25).
 *
 * Usage (depuis apps/api, avec DATABASE_URL dans .env) :
 *   pnpm exec tsx --env-file=.env scripts/anonymize-user.ts client@example.com
 *   pnpm exec tsx --env-file=.env scripts/anonymize-user.ts <uuid> --reason "demande écrite du 2026-07-01"
 *
 * Imprime les clés S3 à purger : la purge S3 doit être faite ensuite
 * (script/console AWS) — voir docs/database.md.
 */
import { PrismaClient } from '@prisma/client';
import { anonymizeUser } from '../src/database/anonymize-user';

async function main(): Promise<void> {
  const [identifier, ...rest] = process.argv.slice(2);
  const reasonFlagIndex = rest.indexOf('--reason');
  const reason = reasonFlagIndex >= 0 ? rest[reasonFlagIndex + 1] : undefined;

  if (!identifier) {
    console.error(
      'Usage : tsx --env-file=.env scripts/anonymize-user.ts <courriel|uuid> [--reason "…"]',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identifier,
    );
    const user = isUuid
      ? await prisma.user.findUnique({ where: { id: identifier } })
      : await prisma.user.findUnique({ where: { email: identifier } });

    if (!user) {
      console.error(`Aucun compte trouvé pour « ${identifier} ».`);
      process.exitCode = 1;
      return;
    }

    const result = await anonymizeUser(prisma, user.id, { actorType: 'system', reason });

    console.log(`Compte ${result.userId} anonymisé le ${result.anonymizedAt.toISOString()}.`);
    console.log('Volumes :', JSON.stringify(result.counts, null, 2));
    if (result.s3KeysToPurge.length > 0) {
      console.log('\n⚠ Clés S3 à purger manuellement :');
      for (const key of result.s3KeysToPurge) console.log(`  - ${key}`);
    } else {
      console.log('Aucune clé S3 à purger.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
