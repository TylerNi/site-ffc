import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Revalidation ISR à la demande (tâche 10) : appelée par l'API admin à la
 * publication/dépublication/archivage d'un produit (`RevalidationClient`,
 * `apps/api/src/modules/catalog/revalidation.client.ts`) pour que le
 * changement apparaisse sur la vitrine en < 60 s sans redéploiement.
 *
 * Authentification par secret partagé (en-tête, jamais dans l'URL/les logs
 * d'accès) — voir `REVALIDATE_SECRET` dans les deux `.env.example`.
 */

const DEV_SECRET = 'dev-secret-revalidate-ffc-ne-jamais-utiliser-en-production';

interface RevalidateBody {
  tags?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.REVALIDATE_SECRET ?? DEV_SECRET;
  const provided = request.headers.get('x-revalidate-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ message: 'Secret de revalidation invalide.' }, { status: 401 });
  }

  let body: RevalidateBody;
  try {
    body = (await request.json()) as RevalidateBody;
  } catch {
    return NextResponse.json({ message: 'Corps JSON invalide.' }, { status: 400 });
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string')
    : [];
  if (tags.length === 0) {
    return NextResponse.json({ message: '« tags » (tableau de chaînes) requis.' }, { status: 400 });
  }

  for (const tag of tags) revalidateTag(tag);

  return NextResponse.json({ revalidated: true, tags });
}
