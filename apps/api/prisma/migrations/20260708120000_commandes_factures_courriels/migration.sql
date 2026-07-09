-- ============================================================================
-- Tâche 12 — Cycle de vie des commandes, factures PDF, courriels transactionnels.
-- Deux garde-fous d'idempotence côté base, indispensables aux effets rejouables
-- (jobs BullMQ, webhooks) : une facture officielle par commande, un courriel
-- transactionnel par clé d'idempotence.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Une seule FACTURE (kind = INVOICE) par commande — index unique PARTIEL.
--    Les notes de crédit (kind = CREDIT_NOTE) restent multiples (un
--    remboursement partiel = une note), donc l'unicité ne vise que la facture.
--    Garantit que deux exécutions concurrentes du job de facturation d'une
--    même commande ne créent jamais deux factures (la seconde échoue à
--    l'insertion et le service retombe sur la facture existante).
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX invoices_one_invoice_per_order
  ON invoices (order_id)
  WHERE kind = 'INVOICE';

-- ----------------------------------------------------------------------------
-- 2. Idempotence d'envoi des courriels : une clé d'idempotence unique.
--    Un courriel transactionnel (confirmation, annulation, remboursement…)
--    rejoué porte la même clé ; la contrainte d'unicité bloque le doublon.
--    Nullable + UNIQUE : les envois non idempotents (courriels de sécurité,
--    tâche 05) laissent la colonne à NULL (PostgreSQL n'unifie pas les NULL).
-- ----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX notifications_idempotency_key_key
  ON notifications (idempotency_key);
