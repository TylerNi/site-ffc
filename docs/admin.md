# Administration — socle et RBAC (tâche 09)

Le tableau de bord admin gère de l'argent, des données personnelles et le
catalogue : c'est une surface d'attaque critique. Ce document décrit le socle
posé en tâche 09 — authentification renforcée, RBAC granulaire appliqué côté
serveur, gestion des comptes du personnel et journal d'audit. Les modules
métier (catalogue, commandes, marketing…) s'y brancheront (tâches 10, 13, 18,
22).

Code : `apps/api/src/modules/admin/` (API), `apps/admin/` (interface),
`packages/core/src/rbac.ts` (source de vérité RBAC). Tests :
`apps/api/test/admin-rbac.e2e.test.ts`.

Principe transversal : **le serveur fait toujours foi**. L'interface masque la
navigation et les actions selon les permissions, mais chaque endpoint est
gardé indépendamment — un `lecture_seule` qui forge une requête reçoit 403.

## 1. RBAC — permissions granulaires et rôles

Le rôle système grossier (`users.role` : CUSTOMER/STAFF/ADMIN) verrouille
l'accès à la surface admin et impose la MFA (tâche 05). Par-dessus, un RBAC fin
data-driven vit dans les tables `roles`, `permissions`, `role_permissions`,
`user_role_assignments` (tâche 04).

- **Permissions** au format `ressource.action` (ex. `orders.refund`,
  `products.write`, `admin_users.write`, `audit.read`). Clé stable, persistée,
  exigée par les gardes. Catalogue dans `@ffc/core` (`ADMIN_PERMISSIONS`).
- **Permission joker `*`** : accorde tout. Portée par `super_admin` en une
  seule ligne — toute nouvelle permission lui est acquise sans re-seed.
- **Rôles de départ** (`ADMIN_ROLES`, brief) :

  | Rôle            | Permissions                                                              |
  | --------------- | ------------------------------------------------------------------------ |
  | `super_admin`   | `*` (toutes)                                                             |
  | `commandes`     | orders.\*, shipments.\*, orders.refund, customers.read, reports.read     |
  | `catalogue`     | products.\*, inventory.\*, reports.read                                  |
  | `marketing`     | promotions.\*, content.\*, reviews.moderate, reports.read                |
  | `lecture_seule` | toutes les `*.read` MÉTIER (ni audit, ni rôles, ni comptes du personnel) |

  Rôles et permissions sont matérialisés par le seed depuis `@ffc/core`.
  Ajuster un rôle **non système** se fait en base, sans redéploiement.

- **Permissions effectives** d'un compte = union des permissions de ses rôles
  assignés (`PermissionService`). Rechargées à chaque accès protégé (peu de
  comptes admin, chemins non chauds) — jamais de cache de droits périmé.

## 2. Chaîne de gardes (tout sous `/v1/admin`)

Le décorateur `@AdminGuarded()` protège chaque contrôleur admin. Ordre
d'exécution (gardes globales puis gardes de contrôleur — ordre garanti par
NestJS, indépendant de l'ordre d'enregistrement) :

1. **JwtAuthGuard** (global) — Bearer JWT valide; le compte est rechargé en
   base à chaque requête (un compte désactivé perd l'accès immédiatement).
2. **RolesGuard** (global) — `@Roles('STAFF','ADMIN')` + **MFA active** exigée.
3. **PermissionsGuard** (contrôleur) — `@RequirePermissions(...)` : charge les
   permissions effectives et exige TOUTES celles listées (joker `*` compris).
4. **StepUpGuard** (contrôleur) — `@RequireStepUp()` : ré-authentification
   récente pour les actions sensibles (voir §4).

Une route admin sans `@RequirePermissions` reste protégée par rôle + MFA
(routes « tout admin » : profil, step-up). Les seules routes publiques sous
`/v1/admin` sont le login et l'acceptation d'invitation (pré-session, par
nécessité).

## 3. Connexion admin dédiée

Parcours distinct du login client (`POST /v1/admin/auth/login` →
`/login/mfa`) :

- Courriel + mot de passe (mêmes vérifications que le client : verrouillage
  progressif, hachage factice à coût constant, erreur 401 neutre).
- **Rôle du personnel exigé** — un compte client reçoit la même erreur neutre
  (ne révèle pas qu'il a visé l'admin).
- **MFA obligatoire** : un compte admin **sans MFA active** reçoit 403 et ne
  peut pas ouvrir de session admin (l'enrôlement se fait par l'espace client,
  `/v1/auth/mfa/*`). Le second facteur est toujours demandé.
- Sessions volontairement **plus courtes que côté client** : cookie de refresh
  à 8 h (au lieu de 30 j) + **déconnexion sur inactivité** (15 min) côté
  interface.

## 4. Step-up — ré-authentification des actions sensibles

Les actions sensibles (remboursements, changements de rôles, désactivations,
exports…) exigent une preuve de second facteur **récente**, en plus de la
session. Mécanisme réutilisable (`@RequireStepUp()` sur n'importe quelle
route) :

- `POST /v1/admin/auth/step-up` avec un code TOTP (ou de secours) émet un
  **jeton de step-up** de 5 min.
- Le jeton est un JWT à **audience distincte** (`ffc-admin-step-up`) : il ne
  peut pas être présenté comme access token, ni l'inverse (pas de confusion de
  jetons). Il est lié au compte **et à la session** (`sid`) : inutilisable
  depuis une autre session.
- Les requêtes sensibles le joignent en en-tête `X-Step-Up-Token`. En son
  absence, le serveur répond 403 avec le code `STEP_UP_REQUIRED` — l'interface
  ouvre alors une fenêtre de confirmation, obtient le jeton, puis rejoue la
  requête. Le jeton est réutilisé pour les actions suivantes dans sa fenêtre.

## 5. Gestion des comptes du personnel

- **Invitation** (`POST /v1/admin/users/invitations`, `admin_users.write` +
  step-up) : crée un compte STAFF **sans mot de passe** (donc incapable de se
  connecter), attribue des rôles, envoie un lien d'acceptation à usage unique
  (jeton `ADMIN_INVITATION`, 7 jours). Ré-invitation idempotente d'un compte en
  attente; 409 si le compte est déjà actif.
- **Acceptation** (`POST /v1/admin/invitations/accept`, public) : le jeton
  reçu par courriel prouve le contrôle de l'adresse; l'invité définit son mot
  de passe, le compte s'active. La MFA reste à activer avant tout accès admin.
- **Attribution de rôles** (`PATCH /v1/admin/users/:id/roles`,
  `admin_users.write` + step-up) : remplace l'ensemble des rôles; audité
  avant/après.
- **Désactivation** (`POST /v1/admin/users/:id/deactivate`, idem) : statut
  DISABLED + **révocation immédiate de toutes les sessions** (l'accès est perdu
  au prochain appel, le compte étant rechargé à chaque requête).
  L'auto-désactivation est refusée.
- **Liste** (`GET /v1/admin/users`, `admin_users.read`) : comptes du personnel
  avec rôles, statut, dernier accès et invitations en attente.

## 6. Journal d'audit

- **Écriture automatique** : `AdminAuditInterceptor` consigne toute mutation
  admin réussie (acteur, action, entité, IP, horodatage). Les routes qui
  consignent un audit détaillé **avant/après** (rôles, désactivation…) sont
  marquées `@AuditManual()` — pas de double entrée.
- **Consultation** (`GET /v1/admin/audit-logs`, `audit.read`) : **lecture
  seule**, filtrable par acteur, entité, action (préfixe) et période; pagination
  par curseur stable. Le journal est **append-only** (trigger SQL, tâche 04) :
  aucune route de modification ni de suppression n'existe.

## 7. Cloisonnement

- L'admin vit sur un **sous-domaine dédié** (`admin.…`) derrière Cloudflare;
  tous les endpoints sont sous le préfixe `/v1/admin`.
- **CORS** distinct de l'API publique (origine de l'admin uniquement),
  `credentials: true` pour le cookie de refresh; en-têtes durcis par `helmet`.
- Le refresh admin réutilise `POST /v1/auth/refresh` (cookie httpOnly partagé,
  `Path=/v1/auth`).

## 8. Socle d'interface (`apps/admin`)

Next.js (App Router, bilingue fr/en). Session en mémoire + restauration
silencieuse par le cookie de refresh au chargement (`AdminAuthProvider`).

- **Login** (courriel + mot de passe → code TOTP), **acceptation
  d'invitation** — pages publiques.
- **Shell authentifié** : navigation par sections **masquée selon les
  permissions** (le serveur reste l'autorité), déconnexion sur inactivité,
  bascule de langue.
- **Tableau de bord** à tuiles (ventes du jour, commandes à expédier, files
  d'attente) — chiffres réels.
- **Utilisateurs** : liste, invitation, édition des rôles, désactivation —
  chaque mutation déclenche la fenêtre de step-up puis rejoue la requête.
- **Journal d'audit** filtrable en lecture seule.
- Composants réutilisables (`components/ui.tsx`) : tables, formulaires,
  fenêtres modales, badges.

## 9. Variables d'environnement (nouvelles)

| Variable        | Rôle                                                 | Défaut                  |
| --------------- | ---------------------------------------------------- | ----------------------- |
| `APP_ADMIN_URL` | base des liens d'invitation du personnel (courriels) | `http://localhost:3001` |

Côté interface : `NEXT_PUBLIC_API_URL` (URL de base de l'API).

## 10. Critères d'acceptation (tests e2e)

`apps/api/test/admin-rbac.e2e.test.ts` :

- un compte `lecture_seule` ne peut ni voir ni appeler une mutation (403 côté
  API, même en forgeant la requête);
- un admin sans MFA active ne peut pas ouvrir de session admin;
- une action sensible sans step-up est refusée; avec step-up elle passe et
  apparaît dans l'audit avec avant/après;
- invitation → acceptation → attribution de rôle → désactivation : parcours
  complet démontré (+ révocation immédiate des sessions).

## 11. Suites prévues

- Modules métier : catalogue/inventaire (10), opérations commandes/promotions
  (22), file de révision IA (18) — se branchent sur ce socle.
- Throttling distribué (Redis) et revue de sécurité complète — tâche 26.
