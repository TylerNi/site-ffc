# IA — pipeline de vision (tâche 17)

Identification du bon filtre à partir d'une photo : le client photographie la
plaque signalétique de son équipement (mode A) ou le cadre de son filtre
actuel (mode B), l'API extrait les informations par un modèle de vision et
propose la correspondance au catalogue. Les écrans client/admin arrivent aux
tâches 18 (web + file de révision) et 19 (mobile) ; cette page documente le
pipeline côté API, ses seuils, ses coûts et ses décisions.

## Vue d'ensemble

```
POST /v1/ai/identifications          { mode, consent: true }
  → consentement vérifié (400 sinon) + tracé dans audit_logs
  → quota quotidien vérifié (429 au-delà)
  → ligne ai_identifications PENDING, purgeAt = créé + 30 j
  → URL S3 présignée (POST, bucket ai-photos, clé ai/<userId>/<uuid>,
    expiration 300 s, taille max 10 Mo imposée par la politique)

client → S3 (POST multipart direct — l'API ne voit jamais les octets à l'aller)

POST /v1/ai/identifications/:id/submit
  → relit l'objet, valide le CONTENU réel (octets magiques JPEG/PNG/WebP/HEIC)
  → ré-encode en JPEG via sharp SANS métadonnées (EXIF/GPS retirés),
    grand côté ≤ 2048 px, remplace l'objet S3
  → job « analyze » dans la file BullMQ ai-vision

worker (file ai-vision)
  → transition PENDING → PROCESSING atomique (updateMany conditionnel)
  → VisionProvider.analyze(image, mode) — sortie structurée validée (zod)
  → correspondance : exacte → alias → floue pg_trgm (mode A) ;
    variantes par dimensions nominales + MERV (mode B)
  → seuil de confiance : COMPLETED ou NEEDS_REVIEW (tuile aiReviewQueue)

GET /v1/ai/identifications/:id       (propriétaire seulement, sinon 404)
```

Modules : `apps/api/src/modules/ai` (contrôleur, service, stockage,
`ai-vision/` pour les fournisseurs, `bench/` pour le banc d'essai) ; types et
schémas partagés dans `packages/core/src/vision.ts` (consommés par l'admin en
tâche 18 et le mobile en tâche 19).

## Les deux modes d'analyse

| Mode                  | Photo                                         | Extraction                                       | Correspondance                                                                                              |
| --------------------- | --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `EQUIPMENT_LABEL` (A) | Plaque signalétique de la fournaise/échangeur | Fabricant + numéro de modèle                     | `equipment_models` (exacte → alias → floue) puis variantes compatibles (`model_filter_compatibility`)       |
| `FILTER_FRAME` (B)    | Cadre du filtre actuel                        | Dimensions imprimées (LxHxP, pouces) + cote MERV | Variantes actives par taille nominale (référentiel d'équivalences nominal ↔ réel de `@ffc/core`) + tri MERV |

**Le mode B est le plus fiable** — le cadre annonce littéralement la taille
cherchée — et doit être mis de l'avant dans les parcours des tâches 18/19.
Chaque prompt demande au modèle de signaler `suggestedMode` quand la photo
appartient manifestement à l'autre mode (l'UI proposera de basculer).

## Interface `VisionProvider` et drivers

Même philosophie que `TaxCalculator` (tâche 11) et `CarrierTracker`
(tâche 14) : le pipeline ne connaît que l'interface
(`ai-vision/vision-provider.ts`) ; chaque implémentation enferme son SDK, son
format de sortie structurée et sa gestion d'erreurs (`retryable` distingue le
transitoire du définitif).

| `AI_VISION_DRIVER`      | Implémentation                                                                               | Sortie structurée                    | Notes                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `log` (défaut dev/test) | Fixture déterministe alignée sur le seed (Lennox G61MPV / 16x25x1 MERV 11)                   | —                                    | Aucune clé, aucun réseau ; les tests pilotent les cas via `stage()`      |
| `anthropic`             | SDK officiel `@anthropic-ai/sdk`, modèle `ANTHROPIC_VISION_MODEL` (défaut `claude-opus-4-8`) | `output_config.format` (json_schema) | `maxRetries: 2`, timeout 90 s ; `stop_reason: refusal` → échec définitif |
| `openai`                | SDK officiel `openai` (API Responses), modèle `OPENAI_VISION_MODEL` (défaut `gpt-5.1`)       | `text.format` json_schema `strict`   | idem                                                                     |

- Le schéma JSON envoyé aux fournisseurs (`ai-vision/vision-schema.ts`) est le
  miroir du schéma zod `visionExtractionSchema` de `@ffc/core`, qui reste la
  seule source de vérité au retour (confiances bornées à [0, 1] avant
  validation ; toute autre divergence = échec du fournisseur).
- Sans clé API (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` optionnelles), les
  endpoints répondent **503** avec un message clair (pattern Stripe, tâche 11).
- En production, `AI_VISION_DRIVER=log` est refusé au démarrage (de faux
  résultats seraient pires qu'une panne) et `S3_AI_PHOTOS_BUCKET` est
  obligatoire.
- **Aucun contenu d'image dans les logs** — uniquement tailles, latences et
  comptes de jetons.

## Traitement asynchrone et idempotence

File BullMQ `ai-vision` (producteur `ai-queue.service.ts`, consommateur
`worker.ts`, concurrence 2, 3 tentatives à backoff exponentiel 15 s) :

- La transition `PENDING → PROCESSING` est un `updateMany` conditionnel
  (`status IN (PENDING, PROCESSING)`). Un job rejoué sur une identification
  déjà en statut terminal sort immédiatement **sans rappeler le fournisseur**
  — jamais de double facturation. Un retry après erreur transitoire (statut
  resté PROCESSING) repasse, lui : l'appel précédent n'a rien produit.
- Erreur transitoire au dernier essai, ou erreur définitive (refus, sortie
  inexploitable) → `FAILED` avec `failureReason`.
- Sans `REDIS_URL` : traitement immédiat dans le processus (attendu en test —
  déterminisme ; différé en dev).

## Correspondance (matching)

Mode A — `ai-matching.service.ts` :

1. **Normalisation** du numéro de modèle : casse, tirets, espaces, ponctuation
   (`G61MPV-36B-070` ≡ `g61mpv 36b 070`).
2. **Exacte** sur `manufacturer + modelNumber` normalisés ; ambiguïté (même
   numéro chez plusieurs fabricants, fabricant illisible) → candidates listées
   sans trancher (révision humaine).
3. **Alias** : `aliases @> …` (index GIN) puis comparaison normalisée par
   `unnest`.
4. **Floue pg_trgm** (index trigram GIN de la tâche 04) : candidates dont la
   similarité ≥ 0,45 (`FUZZY_CANDIDATE_THRESHOLD`), meilleure candidate +
   score persistés. À ≥ 0,85 (`FUZZY_ACCEPT_THRESHOLD`), la meilleure est
   retenue automatiquement (variation triviale de graphie).

**Cache de correspondance** : la table `equipment_models` + alias (enrichis
par la file de révision, tâche 18) _est_ le cache par numéro normalisé — un
numéro déjà résolu court-circuite le flou et **ne repasse jamais en
révision**, même sous le seuil de confiance.

Mode B : dimensions extraites → `canonicalDimensionLabel` +
`dimensionEquivalents` (`@ffc/core` : nominal ↔ réel, orientation
interchangeable) → variantes actives par `nominalLabel`, cote MERV exacte en
tête, puis MERV et format de boîte croissants (10 max).

Le résultat complet est persisté dans l'enveloppe JSONB
`ai_identifications.extraction` (`aiExtractionEnvelopeSchema` de `@ffc/core`) :
`{ mode, vision, match?, variants? }` — plus `matchedEquipmentModelId` en
colonne.

## Seuils et réglages (`settings`)

| Clé                  | Défaut | Rôle                                                                                                                                                                                                   |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ia.seuil_confiance` | 0.85   | Confiance globale ≥ seuil **et** correspondance trouvée → `COMPLETED` ; sinon `NEEDS_REVIEW` (sauf cache de correspondance, voir ci-dessus). Extraction sans correspondance → toujours `NEEDS_REVIEW`. |
| `ia.quota_quotidien` | 10     | Analyses par utilisateur et par jour (UTC). Au-delà → 429 avec message clair. Un `@Throttle` par IP (30 / 15 min) borne en plus les rafales sur les endpoints.                                         |

Modifiables en base sans redéploiement (admin, tâche 22) ; valeurs illisibles
→ repli sur le défaut avec avertissement au log.

## Sécurité du téléversement

- **Clés non devinables** : `ai/<userId>/<uuid>` ; bucket privé, objet jamais
  public ; URL présignée à expiration courte (300 s).
- **Politique S3** : le brief demandait « PUT … taille max imposée par la
  politique » — seul un **POST présigné** (`createPresignedPost`,
  `content-length-range` 1 → 10 Mo) sait faire respecter la taille par S3
  lui-même ; un PUT présigné simple ne le peut pas (même constat que les
  images produit, tâche 10). Décision : POST présigné.
- **Défense en profondeur à la soumission** : taille revérifiée (11 Mo →
  400), type détecté par **octets magiques** (JPEG `FF D8 FF`, PNG, `RIFF…WEBP`,
  boîte `ftyp` HEIF) — jamais l'extension ni le Content-Type déclaré : un
  exécutable renommé `.jpg` est rejeté sur son contenu.
- **EXIF retiré** : ré-encodage sharp (orientation appliquée puis métadonnées
  abandonnées) — les coordonnées GPS du domicile ne quittent jamais la
  soumission ; vérifié par test sur les octets stockés.
- **HEIC** : la signature est acceptée, mais les binaires précompilés de
  sharp/libvips ne décodent pas le HEVC (brevets). Si le décodage échoue →
  400 avec message clair (« convertissez en JPEG ») ; l'app mobile (tâche 19)
  convertira côté client. Alternative future : image compilée avec libheif
  HEVC sous licence.
- **Propriété** : toutes les lectures/écritures sont filtrées par `userId` ;
  l'identification d'un autre compte répond 404 (jamais 403 — pas de fuite
  d'existence).
- Relais `POST /v1/ai/dev-uploads` : dev/test uniquement (404 dès qu'un vrai
  bucket est configuré), même borne de taille que la politique S3.

## Loi 25 et confidentialité

- **Consentement explicite** : `consent: true` obligatoire à la création
  (refus 400), tracé dans `audit_logs`
  (`ai.identification.creation`, metadata `{ mode, consent, retentionDays }`).
- **Transfert hors Québec** : l'appel de vision envoie la photo aux API
  Anthropic ou OpenAI (États-Unis). À consigner au registre des traitements et
  dans la politique de confidentialité (tâche 26). Les photos **au repos**
  restent dans `ca-central-1`.
- **Aucun entraînement** : ni Anthropic ni OpenAI n'utilisent les données
  soumises par API pour entraîner leurs modèles par défaut ; **n'activer
  aucune option** de partage/rétention étendue chez les fournisseurs (aucun
  paramètre de ce genre n'est envoyé par le code). À refléter dans la
  politique de confidentialité (tâche 26).
- **Purge à 30 jours** : `purgeAt = créé + 30 j` fixé à la création ; job
  quotidien (`upsertJobScheduler` sur la file `ai-vision`) qui supprime
  l'objet S3 **puis** remplace `extraction` par le marqueur minimal
  `{ mode, purge: { purgedAt } }` et pose `purgedAt`. Idempotent (relance sans
  effet) ; si la suppression S3 échoue, la ligne reste due et repasse au
  prochain passage. **La BD est la source de vérité** — le cycle de vie S3 à
  30 jours (`infra/terraform/modules/environment/storage.tf`) n'est qu'un
  filet.
- **Suppression de compte** : `ai_identifications.user_id` est en
  `onDelete: Cascade` (tâche 04) — l'anonymisation emporte les identifications.

## Coûts (estimation)

Une photo assainie (JPEG ≤ 2048 px) ≈ 1 500–2 500 jetons d'entrée + ~400 de
prompt ; la sortie structurée ≈ 250–400 jetons (plus la réflexion du modèle
le cas échéant). Ordres de grandeur par photo aux tarifs publics de juillet
2026 (voir `bench/vision-pricing.ts`, à rafraîchir avant toute décision) :

| Modèle                     | Entrée $ US/MTok | Sortie $ US/MTok | ≈ $ US/photo |
| -------------------------- | ---------------- | ---------------- | ------------ |
| `claude-opus-4-8` (défaut) | 5,00             | 25,00            | ~0,02–0,06   |
| `claude-sonnet-5`          | 3,00             | 15,00            | ~0,01–0,03   |
| `claude-haiku-4-5`         | 1,00             | 5,00             | ~0,004–0,01  |
| `gpt-5.1` (défaut GPT)     | 1,25             | 10,00            | ~0,006–0,02  |
| `gpt-5-mini`               | 0,25             | 2,00             | ~0,001–0,004 |

À 10 analyses/jour/utilisateur (quota) le risque budgétaire est borné ; le
**coût réel** mesuré (jetons exacts × tarifs) sort du banc d'essai.

## Banc d'essai comparatif (`ai:bench`)

```bash
pnpm --filter @ffc/api ai:bench -- --dossier <photos> --attendu <verite.csv> \
     [--sortie docs/ia-banc-essai.md] [--sans-correspondance]
```

- Exécute les **deux** fournisseurs configurés (clés dans `apps/api/.env`) sur
  chaque photo listée, avec le **même** assainissement, les **mêmes** prompts
  et la **même** sortie structurée que la production.
- CSV de vérité (en-tête obligatoire, champs vides = non évalués) :

  ```csv
  fichier,mode,fabricant,numero_modele,largeur,hauteur,profondeur,merv
  IMG_0012.jpg,EQUIPMENT_LABEL,Lennox,G61MPV-36B-070,,,,
  IMG_0013.jpg,B,,,16,25,1,11
  ```

- Produit `docs/ia-banc-essai.md` : précision par champ et par mode, taux de
  correspondance en base (si `DATABASE_URL` joignable), latence (moyenne /
  p50 / max), **coût réel par photo** (jetons × tarifs) et recommandation
  motivée (précision d'abord, écart > 3 points décisif ; sinon coût, puis
  latence).
- **[À CONFIRMER]** : jeu de ~50 vraies photos à fournir par l'équipe — le
  script accepte n'importe quel dossier. La logique (CSV, comparaison,
  agrégats, rapport) est couverte par des tests automatisés sur fixtures
  anonymisées (`test/ai-bench.unit.test.ts`).

## Décisions et notes

- **POST présigné plutôt que PUT** : seule façon de faire respecter la taille
  par S3 (voir Sécurité) ; l'esprit du brief (borne imposée par la politique)
  prime sur la lettre.
- **Le mode vit dans l'enveloppe JSONB** : le schéma de la tâche 04 n'a pas de
  colonne `mode` — `extraction.mode` est posé dès la création et survit à la
  purge (marqueur minimal).
- **Réflexion des modèles désactivée** (aucun paramètre `thinking`/effort
  envoyé) : l'extraction d'étiquette est un travail de lecture, pas de
  raisonnement — coût et latence prévisibles ; le banc d'essai tranchera si la
  qualité l'exige.
- **Quota en UTC** : bascule à minuit UTC (20 h/19 h heure de Montréal) —
  simple et déterministe ; à raffiner si le support reçoit des plaintes.
- **`attemptsMade` BullMQ v5** est 0-based pendant le traitement (retentative
  si `attemptsMade + 1 < attempts`) — le worker calcule `finalAttempt` ainsi
  pour transformer la dernière erreur transitoire en `FAILED`.
- Anonyme (schéma `userId` nullable) : **hors portée v1** — endpoints
  authentifiés seulement, conformément au brief.
