# Assets de marque — vitrines BigCommerce actuelles

Références visuelles extraites des deux vitrines en production le 2026-07-11,
pour reproduire la même esthétique sur la nouvelle plateforme (voir
`docs/marque.md` pour la palette et les conventions complètes).

| Fichier                            | Source                                                                                            | Note                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero-accueil.jpg`                 | `cdn11.bigcommerce.com/s-r4k2e4q/.../filtration-montreal-filtre-fournaise-qualite-superieure.jpg` | 822×979. **Identique au pixel** sur les deux vitrines (l'URL EN `s-13a71/.../furnace-filters-canada-premium-air-filters.jpg` sert le même fichier). Filtre Camfil + trophée. |
| `favicon-filtrationmontreal.png`   | `cdn11.bigcommerce.com/s-r4k2e4q/product_images/filtre-a-fournaise.png`                           | 16×16 — référence seulement.                                                                                                                                                 |
| `favicon-furnacefilterscanada.png` | `cdn11.bigcommerce.com/s-13a71/product_images/maple_leaf_flavicon.png`                            | 16×16 (feuille d'érable) — référence seulement.                                                                                                                              |

**Correction (tâche 28)** : malgré leurs noms, ces deux fichiers sont
**identiques au pixel** (même hash) — une feuille d'érable rouge. La note
« favicons distincts par domaine » plus bas dans ce fichier ne reflète pas
la réalité (vérifiée en comparant les octets des deux PNG, puis confirmée
via le `<link rel="icon">` HTML live des deux vitrines, qui pointe vers la
même image sur le CDN BigCommerce). La nouvelle plateforme sert donc une
icône unique (feuille d'érable, recolorée en vert de marque) sur les deux
domaines — voir `docs/marque.md`.

Les photos de produits ne sont pas copiées ici : elles arrivent par l'import
BigCommerce (tâche 08) vers S3 `product-images`.

Il n'existe **aucun logo image** : les deux logos sont du texte
(Poppins gras, majuscules, interlettrage) — « FURNACE FILTERS CANADA » et
« FILTRATION MONTREAL ».
