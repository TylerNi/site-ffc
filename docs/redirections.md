# Redirections 301 de bascule — pipeline et règles (tâche 25)

Chaque URL des vitrines BigCommerce (furnacefilterscanada.com,
filtrationmontreal.com) doit aboutir en **UNE seule 301** sur la page
équivalente de la nouvelle plateforme — jamais de redirection approximative,
jamais de 301 par défaut vers l'accueil, jamais de chaîne. Ce document décrit
le pipeline de génération, les règles servies au runtime et la procédure de
régénération.

## Vue d'ensemble

```
data/urls-bigcommerce.csv   (tâche 08 : URLs officielles + id appariés)
data/urls-crawl.csv         (bigcommerce:crawl : sitemaps publics + BFS borné)
data/redirections-decisions.json  (décisions humaines versionnées)
base Prisma                 (slugs ACTUELS : produits ACTIVE, catégories actives)
        │
        ▼  pnpm --filter @ffc/api bigcommerce:redirects
apps/web/src/redirects/redirects.generated.json   (artefact du middleware)
data/redirections-ecarts.json + rapport-redirections.md  (écarts BLOQUANTS)
        │
        ▼  au runtime (apps/web/src/middleware.ts, AVANT next-intl)
301 absolue / 410 / passage normal — lookups O(1) en mémoire
```

Le contrat partagé (types, normalisation des chemins, liste des paramètres de
suivi) vit dans `packages/core/src/redirects.ts` : le générateur et le
middleware utilisent **exactement la même fonction** `normalizeRedirectPath`
— aucune dérive possible entre les clés écrites et les clés cherchées.

## Génération

1. **Sources.** Le CSV de la tâche 08 (613 lignes, id appariés `en:34`…)
   prime sur le crawl pour la classification; le crawl ajoute ce que l'API ne
   liste pas (billets de blogue, pagination, vieux liens encore présents dans
   le contenu). Les doublons sont fusionnés par (hôte, chemin normalisé).
2. **Résolution.** Produits et catégories se résolvent par identifiant
   BigCommerce → slug **actuel** en base (locale de l'hôte). Seuls les
   contenus réellement servis (produit `ACTIVE`, catégorie active) deviennent
   des cibles. Tout le reste (pages CMS, blogue, marques, URLs découvertes)
   exige une entrée dans `data/redirections-decisions.json` :
   `redirect` (cible vérifiée), `gone` (410 assumé) ou `pending` (blocage
   documenté).
3. **Vérifications.** À la génération : cible existante sur la vitrine
   (statiques localisées, slug en base, taille du référentiel), zéro boucle,
   zéro chaîne (une cible n'est jamais elle-même redirigée), zéro conflit.
   Toute violation **fait échouer la génération**.
4. **Écarts.** Toute URL sans décision sort dans `rapport-redirections.md` et
   `data/redirections-ecarts.json`, et le script sort en code 1 : la bascule
   est bloquée tant que le rapport n'est pas vide.

## Règles servies au runtime

Le middleware (`apps/web/src/middleware.ts`) traite GET/HEAD avant next-intl :

| Requête entrante                         | Réponse                                             |
| ---------------------------------------- | --------------------------------------------------- |
| Chemin de la table (`/m8-1056/`)         | 301 absolue vers la cible (`/products/m8-1056`)     |
| Variantes casse/slash (`/M8-1056//`)     | même 301 (normalisation avant lookup)               |
| `?sort=`, `?page=`, facettes             | ignorés — la cible est la page canonique            |
| `utm_*`, `gclid`, `fbclid`… (allowlist)  | préservés sur la cible                              |
| `search.php?search_query=X`              | 301 vers `/search?q=X` (en) / `/recherche?q=X` (fr) |
| apex (`furnacefilterscanada.com`) + http | UNE 301 combinée vers `https://www.…` + cible       |
| Chemin abandonné (wishlist, rss…)        | 410 avec petit corps localisé `noindex`             |
| Chemin inconnu                           | passage normal → 404 localisée + vigie SEO          |

- **Interrupteur de sûreté** : la variable `REDIRECTS_ENABLED` doit valoir
  `1`, sinon le middleware est inerte (rien en production avant la bascule,
  voir `docs/bascule-dns.md`).
- **Coût** : tables chargées une fois au démarrage (Maps), un chemin courant
  coûte une normalisation de chaîne et deux lookups. Le test
  `apps/web/src/redirects/redirects.test.ts` chronomètre 100 000 lookups
  manqués (< 1 s) et vérifie 100 % des entrées de l'artefact commité, la
  comptabilité complète CSV + crawl, et recroise chaque cible avec le routage
  réel (`routing.ts`).
- Les chemins `.php` sont atteints grâce à la seconde entrée du `matcher`
  (`/(.*\.php)`) — la règle générale exclut les chemins « à point ». Le test
  refuse toute clé à point qui ne finirait pas en `.php`.

## Régénérer l'artefact

```bash
# 1. Base dev à jour (slugs = source des cibles)
pnpm --filter @ffc/api bigcommerce:import      # import EN (S3 requis)
# 2. Inventaire frais des vitrines (public, poli, sans jeton)
pnpm --filter @ffc/api bigcommerce:crawl       # → data/urls-crawl.csv
# 3. Génération + rapport d'écarts
pnpm --filter @ffc/api bigcommerce:redirects   # exit 1 s'il reste un écart
```

Commiter ensemble : l'artefact, `data/redirections-ecarts.json`,
`rapport-redirections.md` et toute évolution de
`data/redirections-decisions.json`.

## État au 2026-07-19 (voir rapport-redirections.md)

- **521 redirections exactes** (331 produits EN, 176 catégories EN, 14
  décisions `.php` sur les deux hôtes) et **6 URLs en 410 assumé**.
- **803 écarts bloquants documentés**, par cause :
  - vitrine FR entière (336 produits + 169 catégories) : **import FR non
    exécuté** — jeton API en attente (tâche 01);
  - 33 produits DRAFT + 40 catégories inactives EN : contenus masqués sur
    BigCommerce (déjà 404 là-bas) — décision `gone`/`ignored` à confirmer;
  - pages CMS (27 EN / 11 FR), marques (14+14), blogue (87 EN / 6 FR) :
    décisions à prendre une fois le rapport SEO (volet tâche 01) reçu —
    jamais de 301 massives vers l'accueil;
  - découvertes du crawl (15 EN / 51 FR) : vieilles URLs encore liées dans le
    contenu (déjà 301 côté BigCommerce), `/blog/`, `/brands/`, passerelles de
    langue `/francais/`↔`/english/` — à trancher au cas par cas.
