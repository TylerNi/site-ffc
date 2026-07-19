-- Vigie SEO post-bascule (tâche 25) : compteur quotidien des 404 de la
-- vitrine, agrégé par (hôte, chemin, jour UTC).

-- CreateTable
CREATE TABLE "storefront_not_found" (
    "id" UUID NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "path" VARCHAR(400) NOT NULL,
    "day" DATE NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "last_referer" VARCHAR(500),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_not_found_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storefront_not_found_day_hits_idx" ON "storefront_not_found"("day", "hits" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "storefront_not_found_host_path_day_key" ON "storefront_not_found"("host", "path", "day");
