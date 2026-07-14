# Vidéos des vitrines BigCommerce actuelles

Inventaire complet relevé le **2026-07-11** en balayant toutes les pages des
sitemaps des deux vitrines (625 pages EN + 537 FR) : **13 vidéos uniques,
toutes des intégrations YouTube** — les sites actuels n'hébergent AUCUN
fichier vidéo. Il n'y a donc rien à télécharger comme média :
la nouvelle plateforme doit les **ré-intégrer par identifiant YouTube**
(mêmes vidéos, zéro hébergement), voir la tâche 24.

## Propriété — point important

Seules **2 vidéos appartiennent à la chaîne « Furnace Filters Canada »** :

- `hjbFuIsqRpQ` — How to Replace VENMAR Air Exchanger Filter
- `nNvMjU3mM_8` — Furnace Filters Canada

Les **11 autres sont des vidéos de tiers** (Camfil UK/USA, Fantech,
AprilAire, Sanuvox, fordummies) : on ne peut PAS les héberger nous-mêmes —
uniquement les intégrer (embed), comme aujourd'hui. Si l'entreprise veut des
copies locales de SES 2 vidéos, les récupérer par YouTube Studio
(propriétaire de la chaîne).

## Contenu du dossier

- `manifest.tsv` — `boutique · page · video_id · chaine · titre · url` :
  chaque ligne = une page d'une vitrine qui intègre une vidéo (21
  associations). C'est la table de câblage pour reproduire les intégrations
  sur les bonnes fiches produits / pages de la nouvelle plateforme
  (les pages sont les URLs actuelles — celles que la tâche 25 cartographie).
- `vignettes/{video_id}.jpg` — vignettes YouTube (maxres, repli hq) des 13
  vidéos : à servir localement pour des **« lite embeds »** (façade cliquable,
  l'iframe YouTube ne se charge qu'au clic) — indispensable pour tenir les
  budgets Core Web Vitals de la tâche 07.
