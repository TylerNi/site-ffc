# syntax=docker/dockerfile:1.7
#
# Image de l'API NestJS (@ffc/api) pour ECS Fargate.
# - Multi-étapes : sous-arbre minimal du monorepo via `turbo prune`, build,
#   puis image d'exécution autonome et minimale.
# - Utilisateur non root, tini comme PID 1 (arrêt propre sur SIGTERM ECS).
# - Même image pour les services `api` et `workers` : seule la commande change
#   (voir infra/terraform — task definitions).

##########  Base : Node 22 + pnpm via corepack  ##########
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# openssl : le moteur Prisma en a besoin pour détecter la bonne cible binaire.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
# Version épinglée = champ packageManager du package.json racine. Sans cela,
# corepack résout « latest » dans les étapes sans package.json (pruner).
RUN corepack enable && corepack prepare pnpm@10.34.4 --activate
WORKDIR /app

##########  Pruner : sous-arbre minimal pour @ffc/api  ##########
FROM base AS pruner
RUN --mount=type=cache,target=/pnpm/store pnpm add -g turbo@^2.5.8
COPY . .
# Produit /app/out/json (manifests), /app/out/full (sources) et un lockfile élagué.
RUN turbo prune @ffc/api --docker

##########  Builder : install + build (@ffc/core puis @ffc/api)  ##########
FROM base AS builder
# 1) Manifests seulement -> couche d'installation cacheable tant que les
#    dépendances ne changent pas.
COPY --from=pruner /app/out/json/ ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
# 2) Sources élaguées + config TypeScript racine (les tsconfig des packages
#    l'étendent, mais `turbo prune` ne la transporte pas).
COPY --from=pruner /app/out/full/ ./
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
# 3) Build via turbo (résout la dépendance ^build : @ffc/core avant @ffc/api).
#    Le build de l'API exécute aussi `prisma generate`.
RUN pnpm turbo run build --filter=@ffc/api
# 4) Paquet d'exécution autonome (dist + node_modules de prod, @ffc/core aplati)
#    dans /app/deploy. Le mode --legacy produit un dossier autoportant fiable.
RUN pnpm --filter=@ffc/api deploy --prod --legacy /app/deploy
# 5) Client Prisma généré DANS le dossier déployé (le client généré du
#    workspace n'est pas transporté par `pnpm deploy`).
RUN cd /app/deploy && ./node_modules/.bin/prisma generate

##########  Runner : image minimale non root  ##########
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=4000
# tini : gestion correcte des signaux (arrêt gracieux orchestré par ECS).
# openssl : requis par le moteur Prisma (détection TLS — recommandation Prisma).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Artefacts autonomes (appartiennent à l'utilisateur non root `node` fourni par l'image).
COPY --from=builder --chown=node:node /app/deploy/dist ./dist
COPY --from=builder --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/deploy/package.json ./package.json
# Schéma + migrations Prisma : requis par l'étape contrôlée de migration du
# pipeline (`prisma migrate deploy` via scripts/migrate.mjs).
COPY --from=builder --chown=node:node /app/deploy/prisma ./prisma
# Script de migration (étape contrôlée du pipeline).
COPY --from=builder --chown=node:node /app/apps/api/scripts ./scripts

USER node
EXPOSE 4000

# Contrôle de santé au niveau image (complémentaire du health check ALB/ECS).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||4000) +'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Service `api`. Le service `workers` surcharge la commande : ["node","dist/worker.js"].
CMD ["node", "dist/main.js"]
