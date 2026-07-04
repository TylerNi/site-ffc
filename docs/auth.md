# Authentification et comptes — architecture et décisions (tâche 05)

L'API NestJS porte toute l'authentification de la plateforme : parcours
courriel, connexions sociales Google/Apple, MFA TOTP, mode invité et droits
Loi 25. Ce document justifie les paramètres et consigne les règles que le
code applique. Code : `apps/api/src/modules/auth/` (+ `account/`, `mail/`,
`audit/`). Tests : `apps/api/test/auth-*.test.ts`, `account-loi25.e2e.test.ts`.

Principe transversal : **aucun secret ni jeton en clair en base**.

| Donnée                                                       | Forme stockée                          | Pourquoi                                                              |
| ------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| Mot de passe                                                 | Argon2id (chaîne PHC)                  | seule défense contre la force brute hors ligne                        |
| Refresh token, jetons à usage unique, jeton de panier invité | SHA-256 hex                            | 256 bits d'entropie → le hachage lent est inutile, l'empreinte suffit |
| Secret TOTP                                                  | AES-256-GCM (clé `APP_ENCRYPTION_KEY`) | doit rester déchiffrable pour valider les codes                       |
| Codes de secours MFA                                         | SHA-256 hex, retirés à l'usage         | usage unique, ~50 bits d'entropie chacun                              |

## 1. Mots de passe — Argon2id

Paramètres (`password.ts`) : **argon2id, m = 64 MiB, t = 3, p = 1**, sel de
16 octets généré par la bibliothèque.

- **64 MiB** : au-delà des minimums OWASP 2024 (19–46 MiB) — le coût mémoire
  est ce qui neutralise les GPU/ASIC. ~100 ms par vérification sur une tâche
  ECS : acceptable pour un e-commerce (le login n'est pas un chemin chaud).
- **t = 3** : compromis latence/résistance recommandé à ce niveau de mémoire.
- **p = 1** : une seule voie pour borner la consommation de threads sous
  charge; la protection vient de la mémoire.
- Les paramètres sont encodés dans la chaîne PHC : on pourra les renforcer
  sans migration (les anciens hachages restent vérifiables).

Politique de mot de passe (NIST 800-63B : la longueur prime sur la
complexité) : **10 à 128 caractères**, aucune classe de caractères imposée.

Anti-énumération par chronométrage : quand le compte n'existe pas (ou n'a
pas de mot de passe), l'API vérifie un **hachage factice** pour que l'échec
coûte le même temps qu'un vrai compte.

## 2. Sessions — JWT 15 min + refresh opaque à rotation

- **Access token** : JWT HS256 (secret `JWT_ACCESS_SECRET`), durée de vie
  **900 s**. Claims réduits au nécessaire : `sub` (id), `role`, `sid`
  (id de session = famille de refresh tokens), `iat/exp/iss/aud`. Aucune
  donnée personnelle (pas de courriel ni de nom).
- **Refresh token** : opaque, 256 bits, **30 jours**, stocké en SHA-256 dans
  `refresh_tokens`. **Rotation obligatoire** : chaque `POST /auth/refresh`
  marque le jeton présenté `used_at` et en émet un nouveau dans la même
  famille (`family_id`).
- **Détection de réutilisation** : présenter un jeton déjà usé ou révoqué
  signifie qu'un client détient un jeton volé (le légitime possède déjà le
  successeur) → **toute la famille est révoquée**, événement
  `auth.refresh.reuse_detected` audité. La consommation est concurrente-sûre
  (UPDATE conditionnel : un seul gagnant, le perdant déclenche la révocation).
- **Multi-appareils** : une connexion = une famille = une session.
  `GET /auth/sessions` liste les sessions actives (IP, user-agent, dernière
  activité, session courante via `sid`); `DELETE /auth/sessions/:id` révoque
  un appareil; `DELETE /auth/sessions` déconnecte les autres appareils
  (`?all=true` inclut la session courante).
- Les guards rechargent l'utilisateur en base à **chaque requête** : un
  compte désactivé/anonymisé perd l'accès immédiatement, sans attendre
  l'expiration du JWT.

### Livraison web vs mobile

- **Web** : le refresh token est posé en **cookie httpOnly** `ffc_refresh`
  (`Secure` en production, `SameSite=Lax`, `Path=/v1/auth`, domaine
  `AUTH_COOKIE_DOMAIN`). Le front n'y touche jamais; `refresh`/`logout`
  lisent le cookie si le corps n'en fournit pas. Web et API partagent le
  même site enregistrable (ex. `filtrationmontreal.com` /
  `api.filtrationmontreal.com`) → Lax suffit, CORS est configuré avec
  `credentials: true`.
- **Mobile** : le refresh token du corps de réponse, stocké dans le
  trousseau (Keychain/Keystore), jamais en AsyncStorage.
- En-têtes durcis par `helmet` sur toutes les réponses.

## 3. Parcours courriel

- **Inscription** (`POST /auth/register`) : réponse **201 identique** que
  l'adresse soit libre ou déjà prise (le hachage est fait dans les deux cas
  pour un coût constant); aucune session n'est ouverte. Un courriel de
  vérification part si le compte est nouveau.
- **Vérification** : jeton à usage unique de **24 h** (`one_time_tokens`,
  finalité `EMAIL_VERIFICATION`). Émettre un nouveau jeton invalide le
  précédent.
- **Réinitialisation** : `POST /auth/forgot-password` répond **202
  systématiquement**; le jeton (30 min, usage unique) part par courriel.
  `POST /auth/reset-password` : nouveau hachage, **révocation de TOUTES les
  sessions**, remise à zéro du verrouillage, courriel « mot de passe
  modifié ». Le lien prouvant le contrôle du courriel, l'adresse est
  considérée vérifiée. Un compte social sans mot de passe peut s'en définir
  un par ce parcours.
- **Changement de mot de passe connecté** : mot de passe actuel exigé
  (échecs comptés au verrouillage), révoque les **autres** sessions.
- Les échecs de connexion renvoient toujours la même erreur 401 neutre
  (« Courriel ou mot de passe invalide »), y compris pour les comptes
  désactivés/anonymisés — la vraie raison va dans `audit_logs`.

## 4. Connexions sociales — Google et Apple (OIDC)

Le client (web/mobile) obtient un **ID token** chez le fournisseur et le
présente à `POST /auth/social/google|apple`. L'API vérifie signature (JWKS
distant mis en cache par `jose`), émetteur, audience (`GOOGLE_CLIENT_IDS`,
`APPLE_CLIENT_IDS`) et expiration. Fournisseur non configuré → 501.

Règles de compte :

1. `sub` du fournisseur déjà lié → connexion (défi MFA si activée, comme au
   login mot de passe).
2. Sinon, **liaison automatique** au compte local de même adresse UNIQUEMENT
   si le fournisseur atteste l'adresse (`email_verified`) **et** que le
   compte local l'a lui-même vérifiée. Un compte local jamais vérifié → 409
   (protection contre la capture de comptes dormants) : se connecter par mot
   de passe (ou le réinitialiser) d'abord.
3. Sinon, création de compte — l'adresse attestée par le fournisseur est
   considérée vérifiée. Apple ne transmettant le nom qu'à la première
   connexion (côté client), `firstName/lastName` sont acceptés dans le corps.

Conformité : **Apple Sign-In est offert partout où Google l'est** —
obligatoire sur iOS dès qu'un autre login social existe (App Store 4.8).

## 5. MFA TOTP (RFC 6238)

- Optionnelle pour les clients, **imposée par le serveur au personnel** :
  toute route exigeant un rôle STAFF/ADMIN vérifie aussi `mfa_enabled`
  (`RolesGuard`) → un admin sans MFA reçoit 403 partout sous `/v1/admin`,
  et `POST /auth/mfa/disable` lui est refusé. Les routes `/auth/mfa/*` ne
  demandent qu'une session : c'est la porte d'enrôlement.
- Paramètres : SHA-1 (standard de fait des applications), 6 chiffres, pas de
  30 s, fenêtre ±1 pas. Secret de 20 octets chiffré AES-256-GCM.
- **Enrôlement en deux temps** : `enroll` génère un secret « pending »
  (URI `otpauth://` + QR en data URL) ; `activate` exige un premier code
  valide avant d'activer — sinon un compte se verrouillerait dehors avec un
  authenticator mal configuré. L'activation retourne **10 codes de secours**
  (montrés une seule fois, stockés hachés, retirés à l'usage).
- **Anti-rejeu** : le dernier pas TOTP accepté est mémorisé
  (`mfa_last_used_step`); un code déjà consommé est refusé même dans sa
  fenêtre.
- **Login à deux facteurs** : mot de passe correct + MFA active →
  `{ mfaRequired: true, challengeToken }` (jeton à usage unique, 5 min).
  `POST /auth/login/mfa` avec le code TOTP **ou un code de secours**. Le
  défi n'est consommé qu'au succès; chaque code erroné compte dans le
  verrouillage progressif du compte.

## 6. Mode invité et fusion de panier

- `POST /auth/guest-cart` crée un panier anonyme et retourne un **jeton
  opaque** (256 bits, stocké haché dans `carts.guest_token`, 30 jours).
- À l'inscription ou à toute connexion (mot de passe, MFA, sociale), le
  client transmet `guestCartToken`; règles de fusion :
  1. compte **sans** panier actif → le panier invité est **rattaché** tel
     quel au compte;
  2. compte **avec** panier actif → les lignes se versent dedans : même
     variante → **les quantités s'additionnent** et le prix consigné à
     l'ajout prend la valeur du panier invité (l'intention la plus récente);
     nouvelle variante → ligne copiée. Le panier invité, vidé, est rattaché
     au compte et marqué `ABANDONED`.
  3. le jeton invité est **invalidé** dans tous les cas (usage unique);
  4. jeton inconnu/expiré/déjà consommé → fusion **ignorée en silence** :
     un panier périmé ne bloque jamais une connexion. Fusion auditée
     (`cart.merge_guest`).
- Les endpoints de contenu du panier (lignes, quantités) arrivent en
  tâche 11.

## 7. Anti force brute

Deux couches complémentaires :

- **Verrouillage progressif par compte** (`lockout.service.ts`, persistant
  en base, effectif multi-instances) : 4 échecs consécutifs libres; au 5e,
  verrou de 1 min, **doublé à chaque échec suivant** (2, 4, 8…) jusqu'au
  plafond de 60 min. Pendant le verrou, même le bon mot de passe est refusé.
  Réponse 429 au **message identique au throttling** (ne confirme pas
  l'existence du compte). Remise à zéro à la connexion réussie et à la
  réinitialisation. Les codes MFA erronés comptent aussi.
- **Rate limiting par IP** (`@nestjs/throttler`, guard global) : 120 req/min
  par défaut, resserré sur les routes sensibles — login/register/reset/MFA :
  **10 / 15 min**, envois de courriel (forgot/resend/deletion) : **5 /
  15 min**, guest-cart : 30 / 15 min. `TRUST_PROXY_HOPS` (2 en production :
  Cloudflare + ALB) fait voir la vraie IP client.
  **Limite connue** : compteurs en mémoire par instance ECS — la limite
  effective est multipliée par le nombre d'instances. Acceptable car le
  verrouillage par compte (en base) reste la défense de fond; un stockage
  Redis partagé pourra être branché en tâche 26 (durcissement).
  `AUTH_THROTTLE_DISABLED=1` est une échappatoire réservée aux tests
  automatisés.

## 8. Loi 25 — export et suppression

- **Export** (`GET /v1/me/export`) : JSON complet des renseignements
  personnels (profil, adresses, appareils, historique de sessions,
  commandes, équipements, identifications IA, avis, préférences,
  notifications, rabais). Sans aucun secret. Accès audité (`user.export`).
- **Suppression** (confirmation forte en deux temps) :
  1. `POST /v1/me/deletion-request` (session exigée) → jeton de 30 min par
     courriel; rien n'est supprimé.
  2. `POST /v1/me/deletion-confirm` avec le jeton → **anonymisation**
     immédiate (stratégie tâche 04, `anonymizeUser` : l'identité disparaît,
     l'historique comptable reste), révocation de toutes les sessions,
     courriel de confirmation envoyé **sans trace en base** (la trace
     retiendrait l'adresse effacée). Preuves exigées : session valide **et**
     contrôle du courriel — valable aussi pour les comptes sociaux sans mot
     de passe.
  - Clés S3 à purger (photos IA, PDF) : journalisées et consignées dans
    l'audit — la purge automatique arrive avec l'outillage S3 (tâche 17).
- Chaîne d'audit : `user.deletion_requested` → `user.deletion_confirmed` →
  `user.anonymize`.

## 9. Courriels de sécurité (SES)

`MailService` (driver `ses` en production via `@aws-sdk/client-sesv2`,
driver `log` en dev/test avec boîte mémoire pour les assertions). Gabarits
bilingues fr/en en texte brut (`templates.ts`), selon la locale du compte :

vérification d'adresse · réinitialisation · **mot de passe modifié** ·
**nouvelle connexion depuis un nouvel appareil** (heuristique : user-agent
jamais vu sur le compte, jamais à la première connexion) · **MFA activée /
désactivée** · demande de suppression · compte supprimé.

Chaque envoi laisse une trace `notifications` (statut, id de message SES)
**sans les variables secrètes** — les liens porteurs de jetons ne sont
jamais persistés.

## 10. Journal d'audit

Tous les événements d'authentification vont dans `audit_logs` (append-only,
tâche 04) avec IP et user-agent : `auth.register`, `auth.register.duplicate`,
`auth.email.verified`, `auth.login.success` (méthode, MFA, nouvel appareil),
`auth.login.failed` (+ verrouillage), `auth.login.blocked`,
`auth.login.mfa_challenge`, `auth.logout`, `auth.refresh.reuse_detected`,
`auth.password.reset_requested`, `auth.password.reset`,
`auth.password.changed`, `auth.mfa.enabled`, `auth.mfa.disabled`,
`auth.mfa.recovery_code_used`, `auth.sessions.revoked`,
`auth.social.linked`, `cart.merge_guest`, `user.export`,
`user.deletion_requested`, `user.deletion_confirmed`, `user.anonymize`.

## 11. Variables d'environnement

Voir `apps/api/.env.example`. Les valeurs de développement de
`JWT_ACCESS_SECRET` et `APP_ENCRYPTION_KEY` sont **refusées au démarrage en
production**, où `MAIL_DRIVER=ses` est également exigé (courriels de
sécurité obligatoires). En production, les secrets viennent d'AWS Secrets
Manager (tâche 03).

| Variable                                   | Rôle                                            | Défaut                                  |
| ------------------------------------------ | ----------------------------------------------- | --------------------------------------- |
| `JWT_ACCESS_SECRET`                        | HMAC des access tokens                          | valeur dev (refusée en prod)            |
| `JWT_ACCESS_TTL_SECONDS`                   | durée des access tokens                         | 900                                     |
| `REFRESH_TOKEN_TTL_DAYS`                   | durée des refresh tokens                        | 30                                      |
| `APP_ENCRYPTION_KEY`                       | AES-256-GCM des secrets TOTP (32 octets base64) | valeur dev (refusée en prod)            |
| `APP_WEB_URL`                              | base des liens des courriels                    | `http://localhost:3000`                 |
| `AUTH_COOKIE_DOMAIN`                       | domaine du cookie de refresh                    | (absent en local)                       |
| `TRUST_PROXY_HOPS`                         | proxys devant l'API                             | 0 (2 en prod)                           |
| `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS`   | audiences OIDC acceptées                        | (social désactivé si absent)            |
| `MAIL_DRIVER` / `MAIL_FROM` / `AWS_REGION` | envoi SES ou log                                | `log` / expéditeur FFC / `ca-central-1` |
| `AUTH_THROTTLE_DISABLED`                   | tests automatisés seulement                     | `0`                                     |

## 12. Ce que la tâche 05 ne couvre pas (suites prévues)

- RBAC fin des routes admin (rôles/permissions en base) — tâche 09.
- Contenu du panier et checkout — tâche 11.
- Purge S3 automatique à la suppression de compte — tâche 17.
- Throttling distribué (Redis) et revue sécurité complète — tâche 26.
