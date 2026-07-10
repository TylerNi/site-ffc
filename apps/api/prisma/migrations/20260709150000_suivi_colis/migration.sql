-- Tâche 14 — suivi de colis unifié.
--
-- Compteur d'échecs CONSÉCUTIFS du polling de repérage, par colis : pilote
-- le recul exponentiel (15 min, 30 min, 1 h… plafonné) sans toucher aux
-- autres colis du même transporteur. Remis à zéro au premier succès.
ALTER TABLE "shipments"
  ADD COLUMN "poll_failures" INTEGER NOT NULL DEFAULT 0;
