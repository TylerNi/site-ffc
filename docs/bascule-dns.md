# Bascule DNS — procédure du jour J (tâche 25)

Basculer `furnacefilterscanada.com` (EN) et `filtrationmontreal.com` (FR) de
BigCommerce vers la nouvelle plateforme, sans coupure de courriel, avec
retour arrière en minutes. **Préalable absolu : `rapport-redirections.md`
vide d'écarts** (le générateur sort en code 1 sinon — voir
`docs/redirections.md`).

## Constat DNS (relevé du 2026-07-19)

⚠️ **Les zones DNS des deux domaines sont déléguées à BigCommerce**
(`ns1/ns2/ns3.bigcommerce.com`) — GoDaddy n'est que le registrar. On ne peut
donc PAS se contenter de « baisser les TTL chez GoDaddy » : il faut d'abord
**reprendre la zone** (Cloudflare, prévu à la tâche 01), puis seulement
changer les cibles le jour J.

Enregistrements à recréer À L'IDENTIQUE dans la nouvelle zone (relevés le
2026-07-19 — re-vérifier avec `Resolve-DnsName`/`dig` avant migration, et
exporter la zone complète depuis l'admin BigCommerce si possible) :

### furnacefilterscanada.com (EN)

| Nom            | Type  | Valeur (avant bascule)                                                        |
| -------------- | ----- | ----------------------------------------------------------------------------- |
| `@`            | A     | `63.141.128.8` (BigCommerce)                                                  |
| `www`          | CNAME | `furnacefilterscanada.com`                                                    |
| `@`            | MX 0  | `furnacefilterscanada-com.mail.protection.outlook.com`                        |
| `@`            | TXT   | `v=spf1 include:_spf.bigcommerce.com include:spf.protection.outlook.com -all` |
| `@`            | TXT   | `MS=ms7978816`                                                                |
| `autodiscover` | CNAME | `autodiscover.outlook.com`                                                    |

### filtrationmontreal.com (FR)

| Nom   | Type  | Valeur (avant bascule)                                                         |
| ----- | ----- | ------------------------------------------------------------------------------ |
| `@`   | A     | `192.200.160.20` (BigCommerce)                                                 |
| `www` | CNAME | `filtrationmontreal.com`                                                       |
| `@`   | MX 0  | `filtrationmontreal-com.mail.protection.outlook.com`                           |
| `@`   | TXT   | `v=spf1 +a +mx include:_spf.bigcommerce.com include:spf.secureserver.net -all` |
| `@`   | TXT   | `v=DKIM1;t=s;p=MIGfMA0GCSqGSIb3DQ…` (recopier verbatim)                        |

**Courriel = intouchable** : MX Microsoft 365, SPF, TXT de vérification et
autodiscover doivent traverser la bascule sans modification (retirer
seulement `include:_spf.bigcommerce.com` des SPF **après** la fenêtre de
garde, jamais le jour J). Ajouter les enregistrements d'envoi AWS SES
(tâche 12) s'ils ne sont pas déjà dans la zone au moment de la migration.

## J-7 et avant — migration de zone (aucun impact visiteurs)

1. Créer les deux zones chez Cloudflare; recopier TOUS les enregistrements
   ci-dessus à l'identique (cibles BigCommerce conservées), TTL **300 s** sur
   `@` A et `www`. Mode DNS-only (nuage gris) pour l'instant.
2. Vérifier les deux zones répondent juste : `dig @<ns-cloudflare> A
furnacefilterscanada.com`, idem `www`, `MX`, `TXT` — comparer au relevé.
3. Chez GoDaddy (registrar) : remplacer les NS `ns*.bigcommerce.com` par les
   NS Cloudflare des zones. La propagation NS prend jusqu'à 48 h, mais les
   deux zones servant les MÊMES réponses, elle est invisible.
4. Vérifier `REDIRECTS_ENABLED` est ABSENTE de l'environnement de production
   web (middleware inerte) et que l'infrastructure cible sert déjà les bons
   contenus quand on force l'hôte :
   `curl -H "Host: www.furnacefilterscanada.com" https://<lb-ou-cloudfront>/ -k`.

## J-2 — gel et répétition

- **Gel BigCommerce** : plus aucune création/modification de produit,
  catégorie, page ou billet sur les deux vitrines (l'artefact de redirections
  est figé sur l'inventaire du gel).
- Regénérer une dernière fois : `bigcommerce:crawl` puis
  `bigcommerce:redirects` — **zéro écart exigé**; commit + déploiement de
  l'artefact.
- Delta d'import : `bigcommerce:export` + `bigcommerce:import` (EN et FR) pour
  capturer les dernières retouches; vérifier les compteurs `updated`.
- Confirmer le TTL 300 s effectivement servi : `dig +noall +answer A
furnacefilterscanada.com` (dernier champ = TTL restant ≤ 300).
- Répéter la séquence J-0 en staging (fumigènes ci-dessous) et confirmer que
  la fenêtre de garde BigCommerce (abonnement actif) couvre AU MOINS 30 jours
  après J-0.

## J-0 — séquence de bascule

Fenêtre recommandée : mardi–jeudi, 6 h–8 h heure de Montréal (trafic minimal,
journée complète de surveillance devant soi).

1. **T-30 min** : delta final `bigcommerce:export` → `bigcommerce:import`;
   `bigcommerce:redirects` (zéro écart); déployer API + web.
2. **T-15 min** : activer `REDIRECTS_ENABLED=1` sur l'environnement web +
   redéployer. Le middleware reste sans effet public (le DNS pointe encore
   vers BigCommerce) mais répond déjà correctement aux tests par en-tête
   `Host`.
3. **T-10 min — fumigènes pré-DNS** (contre le load balancer / CloudFront,
   en forçant `Host`) :
   ```bash
   BASE=<lb-ou-distribution>
   curl -sI -H "Host: www.furnacefilterscanada.com" "$BASE/m8-1056/"        # 301 → /products/…
   curl -sI -H "Host: www.furnacefilterscanada.com" "$BASE/M8-1056"          # même 301 (casse)
   curl -sI -H "Host: www.furnacefilterscanada.com" "$BASE/cart.php"         # 301 → /cart
   curl -sI -H "Host: www.furnacefilterscanada.com" "$BASE/wishlist.php"     # 410
   curl -sI -H "Host: www.filtrationmontreal.com"   "$BASE/cart.php"         # 301 → /panier
   curl -sI -H "Host: www.furnacefilterscanada.com" "$BASE/jamais-existe"    # 404 (pas 301 accueil)
   ```
4. **T-0 — DNS (Cloudflare, les deux zones)** : pointer `@` et `www` vers la
   nouvelle plateforme (CNAME/alias CloudFront ou proxy Cloudflare). NE PAS
   toucher MX/TXT/autodiscover. Propagation effective ≤ 5 min (TTL 300 s).
5. **T+10 min — fumigènes publics** : mêmes `curl` sans forcer `Host`, en
   `https://www.…` et en apex/http (`curl -sI http://furnacefilterscanada.com/m8-1056/`
   → UNE 301 vers `https://www.furnacefilterscanada.com/products/…`);
   parcours complet : accueil → fiche → panier → paiement test → confirmation.
6. **T+30 min — Search Console** (les deux propriétés) : soumettre
   `https://www.furnacefilterscanada.com/sitemap.xml` et
   `https://www.filtrationmontreal.com/sitemap.xml`; demander l'indexation
   des 5 pages les plus importantes par domaine.
7. Brancher la vigie : rapport quotidien des 404 (`/v1/admin/seo/not-found`,
   voir `docs/vigie-seo.md`).

## GO / NO-GO (décision à T+45 min)

**GO (on reste)** si TOUS les critères tiennent :

- 100 % des fumigènes publics passent (301 uniques, 410, 404 propres);
- page d'accueil et 5 fiches produits par domaine en < 3 s (LCP réel);
- une commande de test complète (paiement, courriel de confirmation reçu);
- taux d'erreur 5xx API < 0,5 % sur 30 min (logs ALB/CloudWatch);
- aucun rebond de courriel entrant (envoyer un test vers les boîtes des deux
  domaines et vérifier la réception).

**NO-GO (retour arrière)** si l'un de ces seuils est franchi :

- 5xx > 2 % soutenu sur 10 min, ou checkout inopérant > 15 min;
- perte de courriel entrant confirmée;
- > 10 % des fumigènes en échec après un redéploiement correctif.

## Retour arrière (< 15 min)

1. Cloudflare : repointer `@` A `63.141.128.8` (EN) / `192.200.160.20` (FR),
   `www` CNAME apex — TTL 300 s ⇒ effet ≤ 5 min.
2. Retirer `REDIRECTS_ENABLED` de l'environnement web (middleware inerte).
3. BigCommerce ressert les vitrines telles quelles (fenêtre de garde payée,
   contenu gelé depuis J-2 : rien n'a divergé).
4. Consigner l'heure, la cause et les mesures; re-planifier après correctif.

La fenêtre de garde BigCommerce reste payée **30 jours minimum** après un GO
confirmé; passé ce délai et la vigie au vert (docs/vigie-seo.md), résilier
BigCommerce et retirer `include:_spf.bigcommerce.com` des SPF.
