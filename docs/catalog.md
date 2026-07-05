# Catalogue et recherche — architecture et décisions (tâche 06)

L'API NestJS expose le catalogue public et une recherche rapide et tolérante.
C'est le socle de la vitrine SEO (tâche 07), de l'app mobile (tâche 16) et de
l'admin (tâche 10). Code : `apps/api/src/modules/catalog/`. Logique de
dimensions partagée : `packages/core/src/dimensions.ts`. Tests :
`apps/api/test/catalog.e2e.test.ts`, `packages/core/src/dimensions.test.ts`.

Principe transversal : **une requête, pas de N+1**. Chaque liste passe par une
requête d'ids paginée par keyset, puis une hydratation groupée
(`findMany … in ids`).

## Endpoints (`/v1/catalog`, tous publics)

| Route                           | Rôle                                                             | Cache            |
| ------------------------------- | ---------------------------------------------------------------- | ---------------- |
| `GET /categories`               | Arbre des catégories localisé, compte de produits par sous-arbre | `long` (10 min)  |
| `GET /products`                 | Liste filtrable, triable, paginée par curseur                    | `medium` (2 min) |
| `GET /products/:slug`           | Fiche par slug localisé : variantes, avis, produits liés         | `medium`         |
| `GET /sizes`                    | Index des tailles disponibles (compte + MERV)                    | `long`           |
| `GET /sizes/:label/equivalents` | Tailles équivalentes/compatibles (nominal ↔ réel)                | `long`           |
| `GET /search`                   | Recherche full-text/trigram tolérante, texte + dimension         | `short` (30 s)   |
| `GET /search/suggest`           | Autocomplétion (tailles + produits), < 50 ms                     | `short`          |

Les en-têtes `Cache-Control` (`public, s-maxage, stale-while-revalidate`)
ciblent le CDN Cloudflare et l'ISR de la vitrine (`catalog.util.ts`).

## Normalisation des dimensions (`packages/core`)

Le cœur de l'UX du marché est la recherche par **dimensions**. Les clients les
écrivent de mille façons — toutes doivent mener au même résultat :

- Séparateurs : `16x25x1`, `16 x 25 x 1`, `16-25-1`, `16*25*1`, `16 by 25 by 1`.
- **Nominal vs réel** : un « 16x25x1 » mesure réellement ~`15¾ x 24¾ x ¾`. Une
  recherche `15 3/4 x 24 3/4 x 3/4` (décimales ou fractions) retrouve le nominal.
- **Orientation interchangeable** : un filtre se pose dans les deux sens, donc
  `25x16x1 ≡ 16x25x1`.
- **Profondeur optionnelle** : `16x25` retourne toutes les profondeurs (1/4/5).

`dimensionEquivalents()` résout une saisie en l'ensemble des **libellés
nominaux** du référentiel `@ffc/core` à interroger en base. La correspondance
se fait avec une tolérance quasi nulle sur le nominal et lâche (±0,15 po) sur le
réel, ce qui distingue bien 4 po (réel 3,75) et 5 po (réel 4,375). Ces
fonctions sont **pures et testées unitairement**, donc réutilisables par la
vitrine et le mobile sans appel réseau.

## Recherche

`extractDimension()` sépare la part dimension de la part texte
(`« 16x25x1 merv 11 »` → dimension `16x25x1` + texte `merv 11`).

- **Dimension pure** → délègue à la liste filtrée par taille (mêmes cartes).
- **Texte** → score par produit = max de trois signaux : `word_similarity`
  (pg_trgm, tolérance aux fautes), correspondance de sous-chaîne (`ILIKE`), et
  `ts_rank` plein-texte (`to_tsvector`/`websearch_to_tsquery`). Le SKU est
  scoré séparément (préfixe > sous-chaîne). Une dimension présente ajoute un
  bonus pour garder les bons gabarits en tête.

L'index GIN trigram sur `product_translations.name` (posé en tâche 04) sert le
filtrage `%`; le score affine le classement. `p95 < 100 ms` sur les seeds,
suggest `< 50 ms` (deux petites requêtes indexées).

## Pagination par curseur (keyset)

Pas d'`OFFSET` : chaque page encode dans un curseur opaque (base64url) les
valeurs des clés de tri de la dernière ligne, et la page suivante applique un
prédicat keyset `(clé, …, id) « strictement après »`. La dernière clé est
toujours l'`id` (unique) → **ordre total, pagination stable** même si des
produits sont ajoutés entre deux pages. Directions mixtes permises
(`catalog.util.ts`, `keysetPredicate`). Tris : pertinence (vedette → ventes),
prix, popularité (unités vendues).

## Filtres combinables

Deux niveaux (`catalog-filters.ts`) :

- **Variante** : dimension (→ libellés), MERV, format de boîte, profondeur. Un
  produit n'est retenu que s'il a **une** variante active satisfaisant **tous**
  ces filtres à la fois (sous-requête agrégée `EXISTS`/`JOIN`).
- **Produit** : marque (slug), catégorie (slug localisé, **sous-arbre** via CTE
  récursive), type d'équipement compatible (via la table de correspondance
  modèle ↔ filtre).

## Validation et erreurs

Paramètres validés à la frontière HTTP (DTO class-validator → OpenAPI riche),
dimensions validées par les schémas zod de `@ffc/core`. Erreurs normalisées
NestJS : `400` (dimension/curseur invalide), `404` (slug/catégorie inconnus).
L'OpenAPI est régénéré et `@ffc/api-client` reflète tous les endpoints.
