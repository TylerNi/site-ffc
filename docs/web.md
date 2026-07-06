# Vitrine web et SEO — architecture et décisions (tâche 07)

La vitrine Next.js (`apps/web`) est la couche découverte/SEO de la plateforme :
pages ISR alimentées par l'API catalogue (tâche 06), données structurées,
sitemaps et hreflang inter-domaines, Core Web Vitals. Pas de panier ni de
checkout — ils arrivent à la tâche 11.

## Pages et modes de rendu

| Route (interne)      | fr / en                       | Rendu                | Revalidation  |
| -------------------- | ----------------------------- | -------------------- | ------------- |
| `/`                  | `/` / `/`                     | ISR                  | ≤ 10 min\*    |
| `/products/[slug]`   | `/produits/…` / `/products/…` | ISR + à la demande   | ≤ 5 min\*     |
| `/sizes`             | `/tailles` / `/sizes`         | ISR                  | ≤ 1 h\*       |
| `/sizes/[label]`     | `/tailles/…` / `/sizes/…`     | ISR (toutes tailles) | ≤ 10 min\*    |
| `/categories/[slug]` | identique                     | dynamique (filtres)  | fetchs cachés |
| `/search`            | `/recherche` / `/search`      | dynamique, `noindex` | fetchs cachés |
| `/sitemap.xml`       | par domaine (en-tête Host)    | route handler        | CDN 1 h       |
| `/robots.txt`        | par domaine                   | route handler        | CDN 1 h       |

\* Next prend le PLUS PETIT `revalidate` de la page et de ses fetchs : le
pied de page interroge le catalogue (120 s), donc les pages ISR se
régénèrent effectivement toutes les ~2 min — voulu, aligné sur le cache de
l'API (`REVALIDATE` dans `src/lib/api.ts` ↔ `CACHE_CONTROL` côté API).

Les segments d'URL sont localisés par les `pathnames` next-intl
(`src/i18n/routing.ts`); les slugs de contenu (produits, catégories)
viennent localisés de l'API. `[...rest]` attrape tout le reste → 404
localisée. Une graphie de taille non canonique (« 25x16x1 »,
« 15 3/4 x 24 3/4 x 3/4 », espaces, étoiles…) fait un **308** vers la taille
nominale canonique — les URL « dimensions réelles » concentrent leur jus SEO
sur une seule page.

## Deux modes d'URL, pilotés par l'environnement

**Tout** (liens internes next-intl, canonical, hreflang, sitemaps, robots)
suit la même règle, lue dans `NEXT_PUBLIC_SITE_URL_FR` / `_EN` :

- **Env absentes (dev)** : une origine unique, français préfixé `/fr`,
  anglais nu. `http://localhost:3000/fr/tailles/16x25x1`.
- **Env définies (production)** : un domaine par locale
  (filtrationmontreal.com → fr, furnacefilterscanada.com → en), **jamais de
  préfixe**. La config `domains` de next-intl n'existe que dans ce mode.

⚠️ Ces variables sont inlinées **au build** (client + middleware) : le build
de production doit s'exécuter avec elles (voir `turbo.json` → `build.env`).
Un hôte non reconnu (staging, IP directe) reçoit `robots.txt: Disallow: /`
et un 404 sur `/sitemap.xml` — rien ne s'indexe hors des domaines officiels.

## SEO technique

- **Métadonnées** (`src/lib/seo.ts`) : chaque page indexable émet un
  canonical absolu + `hreflang` `fr-CA`/`en-CA`/`x-default` (x-default →
  anglais). Les fiches produit utilisent les slugs des deux locales exposés
  par l'API (`ProductDetailDto.slugs`); une traduction manquante n'émet pas
  d'alternate. Les listes filtrées/paginées passent `noindex` et gardent le
  canonical de la page nue.
- **JSON-LD** (`src/lib/jsonld.ts`, builders purs testés) : `Organization`
  et `WebSite` + `SearchAction` (layout), `Product` avec `AggregateOffer`
  (bornes de prix, devise, disponibilité) et `aggregateRating` seulement
  s'il y a des avis, `BreadcrumbList` partout où il y a un fil d'Ariane.
- **Sitemaps** (`src/lib/sitemap.ts` + `app/sitemap.xml/route.ts`) : un
  sitemap par domaine (Host), chaque URL portant ses alternates
  `xhtml:link` inter-domaines et le `lastmod` des produits. Source :
  `GET /v1/catalog/sitemap` (slugs fr/en + updatedAt). API indisponible →
  **503 + Retry-After** (jamais de sitemap vide, qui désindexerait).
  Volume actuel ~60 URL/locale; fractionner au-delà de ~10 000 produits.
- **robots.txt** : sitemap du domaine + `Disallow` des pages de recherche.
- La bascule de langue lit le `link[hreflang]` de la page — une seule source
  de vérité pour les slugs croisés.

## Robustesse (API indisponible)

- Pages de liste (accueil, tailles, catégories, recherche) : état
  « catalogue momentanément indisponible », la page se régénère vite.
- Fiche produit : 404 **seulement** sur un vrai 404 API; API injoignable →
  erreur (error.tsx) — jamais de 404 mensonger ni de coquille vide en cache.
- `generateStaticParams` : liste vide si l'API ne répond pas — **le build ne
  peut pas échouer pour une raison réseau** (les pages se matérialisent à la
  demande ensuite).

## Core Web Vitals

- Police Inter via `next/font` (auto-hébergée, `display: swap`).
- Composants serveur par défaut; le JS client se limite à la recherche
  (autocomplétion `/search/suggest`, formulaire GET fonctionnel sans JS),
  à la bascule de langue et à `useReportWebVitals` (console en dev, GA4 si
  `gtag` présent). First-load JS ~102–109 kB.
- Images : les seeds n'ont pas de CDN (tâche 08). `ProductImage` rend un
  placeholder SVG inline dimensionné (zéro requête, zéro CLS) tant que
  `NEXT_PUBLIC_ASSETS_BASE_URL` n'est pas défini; passer à `next/image` en
  branchant le CDN à la tâche 08.

## Variables d'environnement

| Variable                      | Rôle                                       |
| ----------------------------- | ------------------------------------------ |
| `NEXT_PUBLIC_API_URL`         | API vue du navigateur (autocomplétion)     |
| `API_URL`                     | API vue du serveur Next (repli : publique) |
| `NEXT_PUBLIC_SITE_URL_FR/_EN` | Origines de production (au **build**)      |
| `NEXT_PUBLIC_ASSETS_BASE_URL` | CDN images (tâche 08)                      |

## Tests

- `apps/web` (vitest, 34 tests) : URL localisées dans les deux modes,
  metadata/hreflang, JSON-LD, XML sitemap/robots, formats monétaires
  fr-CA/en-CA, parsing des filtres d'URL.
- `apps/api` : e2e des slugs localisés croisés et de l'endpoint sitemap
  (`catalog.e2e.test.ts`).
- Vérifié de bout en bout : build sans API (12/12 pages), build avec API
  (88 pages dont 48 fiches et 28 pages de taille), 308 canoniques,
  sitemaps/robots par Host, `noindex` recherche et listes filtrées, 404.
