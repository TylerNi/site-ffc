# Import du catalogue BigCommerce — mapping et décisions (tâche 08)

Migration ponctuelle des deux vitrines BigCommerce (`furnacefilterscanada.com`
en anglais, `filtrationmontreal.com` en français) vers le schéma Prisma de la
tâche 04. Code : `apps/api/src/bigcommerce/`. Scripts CLI :
`apps/api/scripts/bigcommerce/{export,import}.ts`. Tests :
`apps/api/test/bigcommerce-*.test.ts` (fixtures dans
`apps/api/test/fixtures/bigcommerce.ts`).

Lecture seule côté BigCommerce (`BigCommerceClient` n'expose que des `GET`) —
aucune des deux vitrines n'est jamais modifiée.

## Vue d'ensemble du pipeline

```
export.ts (API BigCommerce) → data/raw/<horodatage>.json
       ↓
transform.ts : pairing.ts + categories.ts + mapping.ts  (PUR, sans réseau/DB)
       ↓
ImportPlan + DiscrepancyReportData
       ↓
import.ts (idempotent, transactionnel) → Prisma          → rapport-import.md
       ↓                                                  → data/urls-bigcommerce.csv
S3 (images WebP + original)
```

`transform.ts` est une fonction pure testée isolément (fixtures) ; c'est elle
qui porte toute la logique métier. `import.ts` ne fait qu'upserter le plan.

## Idempotence : champs ajoutés au schéma

BigCommerce est constitué de **deux boutiques distinctes** : leurs
identifiants numériques (`product_id`, `category_id`, `brand_id`) ne sont PAS
comparables entre les deux vitrines. Aucun champ d'identifiant externe
n'existait sur le catalogue avant cette tâche (contrairement à
`Payment.externalId`/`WebhookEvent.externalId`, déjà idempotents). Migration
`20260706181134_bigcommerce_import_ids` ajoute, tous nullables et uniques :

| Modèle           | Champ                   | Format                                                                                         |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `Brand`          | `bigcommerceBrandId`    | `en:<id>` ou `fr:<id>` — vitrine de référence                                                  |
| `Category`       | `bigcommerceCategoryId` | `en:<id>` ou `fr:<id>`                                                                         |
| `Product`        | `bigcommerceProductId`  | `en:<id>` ou `fr:<id>` (EN prioritaire si apparié)                                             |
| `ProductVariant` | `bigcommerceVariantId`  | `en:<id>`/`fr:<id>` — filet de sécurité, la clé réelle d'idempotence reste `sku` (déjà unique) |

Le préfixe de vitrine évite toute collision entre deux numérotations
indépendantes. Deux exécutions de `import.ts` sur le même export → upsert par
ces clés → mêmes comptes, aucun doublon (vérifié par
`test/bigcommerce-import.test.ts`).

## Appariement fr ↔ en (`pairing.ts`, `categories.ts`)

- **Produits** : apparié par **SKU de variante partagé** entre les deux
  vitrines (fiable — un même produit physique a le même SKU des deux côtés).
  Sans SKU commun, une heuristique (dimensions communes + marque identique +
  recouvrement du nom) propose des **candidats**, jamais un appariement
  automatique — ils sont listés dans `rapport-import.md` sous « Paires
  candidates à revue manuelle » pour confirmation humaine.
- **Aucun produit n'est perdu faute d'appariement** : un produit sans
  correspondance (ou seulement candidat) est importé quand même en
  **unilingue** (une seule `ProductTranslation`) et signalé dans « Produits
  sans équivalent dans l'autre langue ». Un import ultérieur peut compléter la
  traduction manquante une fois la bonne paire confirmée manuellement.
- **Catégories** : les deux arborescences sont supposées avoir la **même
  forme** (même nombre de nœuds, mêmes positions), seuls les libellés
  changent selon la langue — appariement par position (`sort_order` puis
  `id`), récursif. Toute catégorie sans équivalent positionnel devient une
  « catégorie orpheline » (importée en unilingue, signalée au rapport plutôt
  que rattachée à l'aveugle).
- **Marques** : unifiées par **nom normalisé** (minuscule, espaces triés) —
  les `brand_id` ne sont pas comparables entre vitrines, mais un nom de
  marque l'est. Un produit sans `brand_id` BigCommerce est rattaché à une
  marque filet « Sans marque (BigCommerce) » plutôt que de bloquer l'import.

## Mapping champ par champ

### Marque (`Brand`)

| BigCommerce (`brands`) | Prisma    | Note                                 |
| ---------------------- | --------- | ------------------------------------ |
| `name`                 | `name`    | Clé d'unification fr/en (normalisée) |
| `custom_url.url`       | `slug`    | Chemin nettoyé des `/` de tête/fin   |
| `image_url`            | `logoUrl` |                                      |

### Catégorie (`Category` + `CategoryTranslation`)

| BigCommerce (`categories`)       | Prisma                            |
| -------------------------------- | --------------------------------- |
| `parent_id`                      | `parentId` (résolu par pairing)   |
| `sort_order`                     | `sortOrder`                       |
| `is_visible` (OU des 2 vitrines) | `isActive`                        |
| `name`                           | `CategoryTranslation.name`        |
| `custom_url.url`                 | `CategoryTranslation.slug`        |
| `description` (HTML → texte)     | `CategoryTranslation.description` |

### Produit (`Product` + `ProductTranslation`)

| BigCommerce (`products`)                         | Prisma                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `is_visible` (OU des 2 vitrines/candidats)       | `status` (`ACTIVE`/`DRAFT`)                                                                                             |
| `is_featured` (OU des 2 vitrines)                | `isFeatured`                                                                                                            |
| `categories[0]` résolu via le pairing catégories | `categoryId`                                                                                                            |
| `brand_id` → nom → marque unifiée                | `brandId`                                                                                                               |
| `name`                                           | `ProductTranslation.name`                                                                                               |
| `custom_url.url`                                 | `ProductTranslation.slug` (conservé identique à l'URL BigCommerce actuelle — simplifie les redirections de la tâche 25) |
| `description` (HTML → texte brut)                | `ProductTranslation.description`                                                                                        |
| `page_title`                                     | `ProductTranslation.metaTitle`                                                                                          |
| `meta_description`                               | `ProductTranslation.metaDescription`                                                                                    |
| — (aucun équivalent BigCommerce v3)              | `ProductTranslation.shortDescription` — laissé `null`, à curer manuellement après import                                |

### Variante (`ProductVariant`)

| BigCommerce                                                                                                                              | Prisma                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `variant.sku`                                                                                                                            | `sku` (clé d'idempotence)                   |
| `variant.upc`                                                                                                                            | `barcode`                                   |
| Taille : option `Size`/`Taille`/`Dimension` > champ personnalisé > nom produit → résolue au référentiel `@ffc/core` (`resolveDimension`) | `nominalLabel`, `nominal*In`, `actual*In`   |
| MERV : option `MERV` > champ personnalisé > nom produit, validé 1–20 (ASHRAE 52.2)                                                       | `merv` (`null` si absent — ex. pré-filtres) |
| Format de boîte : option `Pack`/`Box`/`Boîte` > nom produit (« Box of N », « Boîte de N »)                                               | `packSize` (défaut `1`)                     |
| `price` (dollars)                                                                                                                        | `priceCents`                                |
| `retail_price` / `cost_price` (niveau produit — BigCommerce ne les décline pas par variante)                                             | `compareAtPriceCents` / `costCents`         |
| `weight` (livres, niveau variante sinon produit)                                                                                         | `weightGrams`                               |

**Tailles non reconnues** : si la chaîne repérée ne correspond à aucune
entrée de `NOMINAL_FILTER_SIZES` (`packages/core/src/filters.ts`), la
variante n'est **pas importée** (dimensions physiques jamais fabriquées) —
elle est listée dans « Variantes sans dimension reconnue » du rapport. Une
fois la taille ajoutée au référentiel `@ffc/core` (ou une faute de saisie
corrigée côté BigCommerce), un nouvel import la reprend automatiquement.

**SKU en double** : un SKU ne peut appartenir qu'à **un seul** produit importé
(contrainte `ProductVariant.sku @unique`). Si le même SKU apparaît sur deux
produits non appariés (erreur de catalogage), il est conservé pour le premier
produit rencontré et ignoré pour les suivants — signalé dans « SKU en double »
plutôt que de faire échouer tout l'import sur une violation de contrainte.

### Images (`ProductImage`)

Téléchargées depuis `url_zoom` (repli `url_standard`), ré-encodées en WebP
(qualité 82, `sharp`) **et** conservées en original, envoyées au bucket S3
`product-images` (`S3ImageStore`, `apps/api/src/bigcommerce/images.ts`).
`ProductImage.url` reçoit la clé S3 WebP (canonique, servie par CDN).
`description` BigCommerce → `altFr`/`altEn` selon la vitrine d'origine.
Réimport : les images d'un produit sont **entièrement remplacées** (delete +
recreate) à chaque exécution — simple et sans doublon, au prix d'un
re-téléchargement à chaque run (pas d'optimisation de cache pour l'instant :
amélioration possible via un hash de l'image source, hors scope de cette tâche).

## Export des URLs (`data/urls-bigcommerce.csv`)

Une ligne par URL actuelle des deux vitrines (produits, catégories, pages —
`GET /content/pages`), avec un `identifiant_apparie` **partagé** entre les
deux locales d'un même produit/catégorie importé (le même que
`bigcommerceProductId`/`bigcommerceCategoryId` en base) — permet à la tâche 25
de reconstruire les paires fr/en et de générer les redirections. Livrable
consommé tel quel, aucun modèle de redirection n'existe encore en base.

## Limite connue : pas encore de jetons BigCommerce réels

La checklist d'accès de la tâche 01 (jeton API admin BigCommerce) n'a pas
encore été complétée à ce stade du projet — voir `taches-a-faire/TACHE01.md`.
`export.ts`/`import.ts` sont donc **prêts à s'exécuter contre les vraies
vitrines** dès que `BIGCOMMERCE_STORE_HASH_*`/`BIGCOMMERCE_ACCESS_TOKEN_*`
(voir `.env.example`) seront disponibles, mais n'ont pu être validés qu'avec
des fixtures reproduisant fidèlement la forme de l'API v3 (`test/fixtures/bigcommerce.ts`),
couvrant chaque cas du brief (paire SKU, candidat de revue manuelle, produit
sans équivalent, taille non reconnue, SKU en double, catégorie orpheline,
produit sans marque/image). L'échantillon de 20 produits du critère
d'acceptation (comparaison avec la vitrine réelle) reste à faire une fois les
jetons obtenus.

## Exécution

```bash
# Depuis apps/api, jetons dans .env (voir .env.example)
pnpm bigcommerce:export                  # → data/raw/<horodatage>.json
pnpm bigcommerce:import -- --dry-run     # calcule les comptes sans écrire
pnpm bigcommerce:import                  # import réel + rapport-import.md + urls-bigcommerce.csv
```
