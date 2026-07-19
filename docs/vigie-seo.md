# Vigie SEO post-bascule (tâche 25 §7)

Après la bascule DNS (`docs/bascule-dns.md`), le référencement se surveille
sur un rythme fixe : **quotidien pendant 2 semaines, puis hebdomadaire
pendant 3 mois**. Deux sources : la table des 404 de la vitrine (interne) et
Google Search Console (externe).

## Instrumentation en place

- **Vitrine** : chaque 404 servi est signalé (hors du chemin critique, via
  `after()`) à `POST /v1/seo/not-found` — hôte, chemin, referer, agrégés par
  jour UTC dans la table `storefront_not_found` (compteur par chemin, plafond
  5 000 chemins/jour/hôte, purge à 90 jours). Actif seulement quand
  `REDIRECTS_ENABLED=1`.
- **Rapport quotidien** : `GET /v1/admin/seo/not-found?day=YYYY-MM-DD&limit=20`
  (permission `reports.read`) — par hôte : total de hits, chemins distincts,
  top N avec dernier referer.

## Cadence

### Quotidien — J+1 à J+14 (10 min)

1. Rapport des 404 de la veille (`/v1/admin/seo/not-found?day=…`).
   - Un chemin BigCommerce connu y figure ⇒ trou dans la table de
     redirections → procédure « Corriger un 404 » ci-dessous.
   - Seulement du bruit de bots (`/wp-admin`, scans `.env`…) ⇒ rien à faire.
2. Search Console (les deux propriétés) : Couverture → « Page introuvable
   (404) » et « Erreur de redirection » (doit rester à zéro); Performances →
   clics/impressions de la veille.
3. Fumigènes rapides : `curl -sI https://www.furnacefilterscanada.com/m8-1056/`
   (301 unique) et une fiche produit au hasard (200).

### Hebdomadaire — semaine 3 à mois 3 (30 min)

1. Même revue 404, sur la semaine (boucler sur `day`).
2. Search Console : comparer clics/impressions/position moyenne de la semaine
   aux **mêmes 7 jours d'avant-bascule** (référence exportée à J-2) et à la
   semaine précédente.
3. Indexation : `site:www.furnacefilterscanada.com` et
   `site:www.filtrationmontreal.com` — les nouvelles URLs (`/products/…`,
   `/produits/…`) doivent progressivement remplacer les anciennes.
4. Core Web Vitals (Search Console → Signaux Web essentiels) : rester au vert.

## Seuils d'alerte (action immédiate, pas d'attente du prochain point)

| Signal                                     | Seuil                             | Action                                                                             |
| ------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------- |
| Clics organiques (7 j vs réf. pré-bascule) | **−20 %**                         | audit 404 + Search Console le jour même                                            |
| Clics organiques (7 j)                     | −40 %                             | mobiliser le point de contact SEO (tâche 01)                                       |
| 404 internes sur chemins BigCommerce       | > 50 hits/jour sur un même chemin | décision + redéploiement sous 24 h                                                 |
| « Erreur de redirection » Search Console   | > 0                               | chercher une chaîne/boucle — ne devrait JAMAIS arriver (garanti par la génération) |
| Pages indexées du nouveau site             | en baisse 2 semaines de suite     | vérifier sitemaps + canonicals                                                     |

## Corriger un 404 découvert par la vigie

1. Identifier la cible correcte (referer du rapport, ancienne page via la
   fenêtre de garde BigCommerce ou l'export `data/raw/`).
2. Ajouter l'entrée à `data/redirections-decisions.json` (`redirect` avec
   cible argumentée, ou `gone` si l'abandon est assumé).
3. `pnpm --filter @ffc/api bigcommerce:redirects` (le test web revalide 100 %
   de l'artefact), commit, déploiement web.
4. Vérifier au `curl` puis marquer le chemin « corrigé » dans le journal.

## Journal de vigie (gabarit)

Tenir dans le suivi d'équipe, une ligne par point :

```
## 2026-MM-JJ (quotidien|hebdo) — vigie par <qui>
- 404 EN : total N (top : /chemin ×N — action/np)
- 404 FR : total N (top : …)
- Search Console EN : clics N (réf. N), erreurs N
- Search Console FR : clics N (réf. N), erreurs N
- Actions : (décisions ajoutées, redéploiements, ou « RAS »)
```

À J-2 de la bascule : exporter depuis Search Console les 90 derniers jours
(clics/impressions par page et par requête, les deux domaines) — c'est la
**référence pré-bascule** de tous les comparatifs ci-dessus.
