-- Tâche 13 — Intégration ShipStation.
--
-- 1. Purolator rejoint les transporteurs (accessible uniquement via ShipStation).
-- 2. shipstation_syncs : boîte d'envoi des commandes payées vers ShipStation,
--    écrite dans la même transaction que le passage à PAID (aucune commande
--    payée ne peut être oubliée), drainée avec retentatives exponentielles.
--
-- Note PostgreSQL : « ALTER TYPE … ADD VALUE » est permis dans une transaction
-- (PG ≥ 12) tant que la nouvelle valeur n'est pas UTILISÉE dans la même
-- transaction — c'est le cas ici.

-- AlterEnum
ALTER TYPE "carrier" ADD VALUE 'PUROLATOR' BEFORE 'OTHER';

-- CreateEnum
CREATE TYPE "shipstation_sync_status" AS ENUM ('PENDING', 'SYNCED', 'SYNC_FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "shipstation_sync_operation" AS ENUM ('CREATE', 'CANCEL');

-- CreateTable
CREATE TABLE "shipstation_syncs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "shipstation_sync_status" NOT NULL DEFAULT 'PENDING',
    "operation" "shipstation_sync_operation" NOT NULL DEFAULT 'CREATE',
    "shipstation_order_id" TEXT,
    "shipstation_order_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "label_created_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipstation_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipstation_syncs_order_id_key" ON "shipstation_syncs"("order_id");

-- CreateIndex
CREATE INDEX "shipstation_syncs_status_next_attempt_at_idx" ON "shipstation_syncs"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "shipstation_syncs" ADD CONSTRAINT "shipstation_syncs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
