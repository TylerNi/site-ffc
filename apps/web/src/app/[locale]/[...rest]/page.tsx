import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { headers } from 'next/headers';
import { reportStorefrontNotFound } from '@/lib/report-404';

/** Attrape-tout : toute URL hors des routes connues → 404 localisée,
 *  signalée à la vigie SEO (tâche 25) après l'envoi de la réponse. */
export default async function CatchAllPage({
  params,
}: {
  params: Promise<{ locale: string; rest: string[] }>;
}) {
  const [{ rest }, requestHeaders] = await Promise.all([params, headers()]);
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const referer = requestHeaders.get('referer');
  after(() =>
    reportStorefrontNotFound({
      host,
      path: `/${rest.map((segment) => decodeURIComponent(segment)).join('/')}`,
      referer,
    }),
  );
  notFound();
}
