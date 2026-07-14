# Photos produits — vitrines BigCommerce actuelles

Photo principale (`og:image`) de **chaque produit** des deux vitrines en
production, moissonnée le **2026-07-11** via les sitemaps
(`/xmlsitemap.php` → pages produit). 667 images (645 JPEG, 22 PNG), toutes
vérifiées; servies par le CDN à leur taille maximale disponible (aucun
suragrandissement — la plupart font ~420–830 px de large, c'est l'original).

## Nommage et appariement avec la nouvelle plateforme

```
assets/produits/
├── furnacefilterscanada/   331 images — boutique EN (CDN s-13a71)
│   └── bc{productId}--{slug}.{ext}     ex. bc102--18x25x2-furnace-filter.jpg
├── filtrationmontreal/     336 images — boutique FR (CDN s-r4k2e4q)
│   └── bc{productId}--{slug}.{ext}     ex. bc100--filtre-fournaise-16x24x1-camfil-30-30.jpg
└── manifest.tsv            l'index machine (voir colonnes ci-dessous)
```

- `{productId}` = identifiant produit BigCommerce **de sa boutique**, `{slug}`
  = slug de l'URL produit actuelle (celle que la tâche 25 redirigera).
- ⚠️ **Les deux boutiques ont des espaces d'ID indépendants** (`bc115` désigne
  un produit différent dans chaque dossier) — ne jamais apparier entre
  dossiers par le numéro seul.
- **Clé d'appariement avec notre base** : le schéma (tâche 04/08) référence la
  **boutique EN** — `products.bigcommerce_product_id` = les `bc{productId}` du
  dossier `furnacefilterscanada/`. Les produits FR s'y rattachent par
  l'appariement fr↔en de l'import (tâche 08, `pairing.ts`); les images FR
  servent quand l'emballage/visuel français diffère.

## `manifest.tsv` (tabulations)

`boutique · bc_product_id · slug · fichier · titre · url_source`

## Portée et limites

- **Photo principale seulement** (une par produit). Les galeries
  multi-images restent à récupérer par l'import API de la tâche 08
  (`pnpm bigcommerce:export/import`, bloqué sur les jetons — checklist
  tâche 01), qui demeure la voie canonique vers S3 `product-images`;
  ce dossier est la source immédiate/de secours, déjà clé-compatible —
  **branchement prévu à la tâche 24** (repli du pipeline d'images).
- EXIF non retiré (photos de produits, aucun enjeu de vie privée).
- Poids total ~78 Mo : si le dépôt devient lourd, envisager Git LFS pour
  `assets/produits/**`.
