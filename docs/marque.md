# Identité visuelle — référence de marque

Relevé effectué le **2026-07-11** sur les deux vitrines BigCommerce en
production (filtrationmontreal.com et furnacefilterscanada.com), couleurs
mesurées au style calculé (DevTools/scripts). **Les deux vitrines partagent
exactement le même thème** : une seule identité, deux logos texte. C'est la
cible esthétique de la nouvelle plateforme (web — tâche 28, mobile — tâche 15,
bandeau promo — tâche 22, gabarits de courriels).

Assets téléchargés : `assets/marque/` (héros d'accueil, favicons des deux
domaines — voir son README).

## Palette

| Rôle                                                    | Hex                                           | Mesure source                                       |
| ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| **Vert d'action** (boutons, CTA)                        | `#26A943`                                     | `rgb(38, 169, 67)` — bouton héros et « MAGASINER »  |
| Vert liens/accents (téléphone, liens verts)             | `#28A745`                                     | `rgb(40, 167, 69)`                                  |
| Vert foncé (dégradés, accents sombres)                  | `#185D34`                                     | `rgb(24, 93, 52)`                                   |
| **Bandeau d'annonce**                                   | `linear-gradient(to right, #185D34, #28A745)` | mesuré sur `.banners`, texte blanc                  |
| Texte courant                                           | `#2F2F2B`                                     | `rgb(47, 47, 43)` — couleur dominante               |
| Titres                                                  | `#191919`                                     | `rgb(25, 25, 25)`                                   |
| Texte secondaire / footer                               | `#B2B2B2`                                     | `rgb(178, 178, 178)`                                |
| Lignes / bordures                                       | `#D7D7D7`                                     | `rgb(215, 215, 215)`                                |
| Fonds pâles (barre de menu, cartes MERV, panneau héros) | `#EBEBEB`                                     | `rgb(235, 235, 235)`                                |
| Fond de page                                            | `#FFFFFF`                                     | blanc pur                                           |
| **Footer**                                              | fond `#1F1F1F`, texte `#B2B2B2`               | `rgb(31, 31, 31)`                                   |
| Étoiles d'avis                                          | `#FFA41C`                                     | `rgb(255, 164, 28)` (FR) / `rgb(255, 164, 26)` (EN) |

## Typographie

- **Poppins** partout (`Poppins, Arial, Helvetica, sans-serif`) — corps,
  titres, boutons. Sur la nouvelle plateforme : `next/font/google` (web) et
  `expo-font`/`@expo-google-fonts/poppins` (mobile).
- Titres du héros : gras, en **MAJUSCULES**, très grands; sous-titres en
  majuscules espacées, graisse normale.
- **Logos = texte** (aucun fichier image) : Poppins gras, majuscules,
  interlettrage large — « FILTRATION MONTREAL » / « FURNACE FILTERS CANADA »,
  en `#191919` sur blanc.

## Composants et ton

- **Boutons** : fond `#26A943`, texte blanc, libellés en MAJUSCULES;
  **pilule** (radius 999px) pour les grands CTA du héros, rectangle arrondi
  pour les boutons standards (« MAGASINER », « Shop »).
- **Bandeau d'annonce** en haut de chaque page : dégradé vert (ci-dessus),
  texte blanc, liens soulignés — c'est l'emplacement du compte à rebours natif
  de la tâche 22.
- **En-tête** : fond blanc, logo texte à gauche, recherche centrale
  (placeholder « Enter Filter Size. Ex: 16x25x5 » / « Recherche »), icônes
  compte/panier à droite; barre de navigation sur fond `#EBEBEB` avec lien
  bascule de langue (FRANÇAIS/ENGLISH) et téléphone en vert.
- **Cartes produit** : fond blanc sobre, nom en gras, note étoilée `#FFA41C`
  avec compte d'avis très visible, prix barré (« Prix/Solde », « Was/Now »).
- **Sections métier** : cartes MERV 8/11/13 sur fond `#EBEBEB` avec CTA vert;
  bloc « Note moyenne globale 4,9 ★ » avec lauriers.
- **Footer** : très sombre `#1F1F1F`, texte `#B2B2B2`.
- Ton général : blanc dominant, vert réservé à l'action et aux annonces,
  photos de produits sur fond blanc, aucune ombre lourde.

## État sur la nouvelle plateforme (après tâche 28)

- `apps/web/src/app/globals.css` : rethèmé (tâche 28) — tokens `--brand:
#26a943`, `--brand-dark: #185d34` (texte/liens, seule combinaison qui
  passe l'AA sur fond blanc à toute taille — voir « Accessibilité »
  ci-dessous), `--brand-accent: #28a745`, `--brand-soft: #ebebeb`, encres
  `--ink`/`--ink-strong`, footer `--footer-bg`/`--footer-text`. Police
  **Poppins** via `next/font/google` (`--font-sans`).
- `apps/mobile` : design system à construire (tâche 15) — s'appuyer sur ce
  document.
- Gabarits de courriels (`apps/api/src/modules/mail/templates.ts`) : bandeau
  de marque et bouton CTA alignés sur le vert (tâche 28).
- **Favicons — correction du relevé initial** : ce document affirmait des
  favicons distincts par domaine (filtre stylisé FR, feuille d'érable EN).
  Vérification faite en tâche 28 (favicons réels des deux vitrines,
  extraits du `<link rel="icon">` HTML live, pas seulement les PNG de
  référence) : **les deux domaines servent en réalité le même fichier**
  (`cdn11.bigcommerce.com/.../filtre-a-fournaise.png` et
  `.../maple_leaf_flavicon.png` sont identiques au pixel — une feuille
  d'érable rouge), malgré le nom du premier fichier. La nouvelle
  plateforme sert donc une **icône unique** (feuille d'érable stylisée,
  recolorée en vert de marque `#26a943`) sur les deux domaines/locales —
  `apps/web/public/icons/maple-leaf.svg` (+ `-32.png`, `-180.png` pour
  `apple-touch-icon`), référencés dans `generateMetadata`
  (`apps/web/src/app/[locale]/layout.tsx`).

## Accessibilité — règle de contraste AA

`#26A943` (vert d'action) sur blanc n'atteint que ~3:1 : conforme AA
seulement pour du texte **large et gras** (≥ ~18,7px gras). Sur la nouvelle
plateforme, ce vert vif n'habille donc que les CTA de cette taille
(`.cart-checkout-btn`, `.btn-primary`) et les accents non textuels
(dégradés d'arrière-plan sans texte dessus, bordures). Tout le reste —
liens, boutons standards (`.btn`/`.btn-add`/`.searchbox button`) — utilise
`#185D34` (~7,9:1, conforme à toute taille).

Deux détails traités à part :

- **Focus visible** : `#185D34` (~7,9:1 sur blanc) mais seulement ~2:1 sur
  le footer sombre (`#1F1F1F`) — sous la barre AA « composant non
  textuel » (3:1). `.site-footer :focus-visible` bascule l'anneau en blanc.
- **Bandeau d'annonce** : le dégradé de marque mesuré (`#185D34 →
#28A745`) porte du texte blanc gras à 13px — sous le seuil « grand
  texte » — et `#28A745` n'y donne que ~3,1:1. Le point d'arrivée du
  dégradé est assombri à `#1f7a3c` (~5,4:1) pour ce cas précis; si la
  tâche 22 (compte à rebours natif) réutilise cette enveloppe avec un
  texte de taille comparable, vérifier son contraste sur le même dégradé.
