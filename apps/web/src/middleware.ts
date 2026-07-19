import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { REDIRECTS_ENV_FLAG } from '@ffc/core';
import { routing } from './i18n/routing';
import { goneResponseBody, resolveRedirect } from './redirects';

const handleI18nRouting = createMiddleware(routing);

/**
 * Redirections 301 de bascule (tâche 25) AVANT le routage next-intl.
 *
 * Interrupteur de sûreté : tant que `REDIRECTS_ENABLED` ne vaut pas `1`, la
 * table est inerte — rien ne change avant le jour de la bascule DNS. Seules
 * les requêtes GET/HEAD sont considérées; l'hôte vient des en-têtes
 * (x-forwarded-host derrière le load balancer), jamais de l'URL interne.
 *
 * La normalisation des barres obliques finales (308) est faite ICI, après la
 * table, car `skipTrailingSlashRedirect` désactive celle de Next : une
 * vieille URL `/m8-1056/` aboutit en UNE seule 301 — jamais 308 puis 301.
 */
export default function middleware(request: NextRequest) {
  if (
    process.env[REDIRECTS_ENV_FLAG] === '1' &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const resolution = resolveRedirect({
      host: request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      proto: request.headers.get('x-forwarded-proto'),
    });
    if (resolution) {
      if (resolution.kind === 'redirect') {
        return NextResponse.redirect(resolution.location, 301);
      }
      return new NextResponse(
        request.method === 'HEAD' ? null : goneResponseBody(resolution.locale),
        { status: 410, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
  }

  const { pathname } = request.nextUrl;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    // URL standard, PAS request.nextUrl.clone() : NextURL mémorise la barre
    // finale de la requête d'origine et la réapplique quand on réassigne
    // `pathname` — la 308 pointerait alors vers elle-même (boucle).
    const target = pathname.replace(/\/+$/, '') || '/';
    return NextResponse.redirect(new URL(target + request.nextUrl.search, request.url), 308);
  }

  return handleI18nRouting(request);
}

export const config = {
  // Tout sauf les routes API, les internes Next et les fichiers statiques —
  // PLUS les chemins `.php` hérités de BigCommerce (cart.php, index.php…,
  // avec ou sans barre finale), que la règle « pas de point » exclurait.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)', '/(.*\\.php)', '/(.*\\.php/)'],
};
