-- ============================================================================
-- Migration manuelle : intégrité critique hors du modèle Prisma.
-- Voir docs/database.md (« Décisions clés ») pour le pourquoi de chaque bloc.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Numéros de commande lisibles (« FFC-100042 »).
--    Séquence native : les trous sont tolérés (seule l'unicité compte).
--    Allocation : src/database/order-number.ts.
-- ----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 100001;

-- ----------------------------------------------------------------------------
-- 2. Numérotation de factures séquentielle SANS TROU par série annuelle.
--    L'UPSERT verrouille la ligne du compteur : les transactions concurrentes
--    se sérialisent, et un ROLLBACK restitue le numéro (aucun trou possible).
--    À appeler UNIQUEMENT dans la transaction qui insère la facture
--    (src/database/invoice-number.ts).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION allocate_invoice_number(p_series text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_next integer;
BEGIN
  INSERT INTO invoice_counters (series, last_value, updated_at)
  VALUES (p_series, 1, now())
  ON CONFLICT (series)
  DO UPDATE SET last_value = invoice_counters.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_next;
  RETURN v_next;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. audit_logs : APPEND-ONLY. Aucune mise à jour ni suppression, même en SQL
--    brut — le journal d'audit ne se réécrit pas.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs est append-only : % interdit', TG_OP;
END;
$$;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();

-- ----------------------------------------------------------------------------
-- 4. order_items : INSTANTANÉS D'ACHAT IMMUABLES.
--    Toute modification des colonnes copiées à l'achat est rejetée. Seule la
--    mise à NULL des références lâches variant_id/product_id (FK SET NULL à la
--    suppression d'une variante/d'un produit) reste permise.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_order_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id                   IS DISTINCT FROM OLD.id
     OR NEW.order_id          IS DISTINCT FROM OLD.order_id
     OR NEW.sku               IS DISTINCT FROM OLD.sku
     OR NEW.name_fr           IS DISTINCT FROM OLD.name_fr
     OR NEW.name_en           IS DISTINCT FROM OLD.name_en
     OR NEW.nominal_label     IS DISTINCT FROM OLD.nominal_label
     OR NEW.merv              IS DISTINCT FROM OLD.merv
     OR NEW.pack_size         IS DISTINCT FROM OLD.pack_size
     OR NEW.quantity          IS DISTINCT FROM OLD.quantity
     OR NEW.unit_price_cents  IS DISTINCT FROM OLD.unit_price_cents
     OR NEW.discount_cents    IS DISTINCT FROM OLD.discount_cents
     OR NEW.subtotal_cents    IS DISTINCT FROM OLD.subtotal_cents
     OR NEW.tax_cents         IS DISTINCT FROM OLD.tax_cents
     OR NEW.total_cents       IS DISTINCT FROM OLD.total_cents
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at
     OR (NEW.variant_id IS DISTINCT FROM OLD.variant_id AND NEW.variant_id IS NOT NULL)
     OR (NEW.product_id IS DISTINCT FROM OLD.product_id AND NEW.product_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'order_items est immuable (instantané d''achat) : corriger une commande passe par un remboursement/une note de crédit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_immutable
BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION forbid_order_item_mutation();

-- ----------------------------------------------------------------------------
-- 5. Contraintes CHECK — dernier rempart sous les validations applicatives.
-- ----------------------------------------------------------------------------

-- Un panier appartient à un compte OU porte un jeton invité.
ALTER TABLE carts
  ADD CONSTRAINT carts_owner_check
  CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL);

ALTER TABLE cart_items
  ADD CONSTRAINT cart_items_quantity_check CHECK (quantity > 0);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_quantity_check CHECK (quantity > 0),
  ADD CONSTRAINT order_items_amounts_check
    CHECK (unit_price_cents >= 0 AND discount_cents >= 0 AND subtotal_cents >= 0
           AND tax_cents >= 0 AND total_cents >= 0);

ALTER TABLE orders
  ADD CONSTRAINT orders_amounts_check
    CHECK (subtotal_cents >= 0 AND discount_cents >= 0 AND shipping_cents >= 0
           AND tax_gst_cents >= 0 AND tax_qst_cents >= 0 AND tax_hst_cents >= 0
           AND tax_pst_cents >= 0 AND total_cents >= 0);

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_amounts_check
    CHECK (price_cents >= 0
           AND (compare_at_price_cents IS NULL OR compare_at_price_cents >= 0)
           AND (cost_cents IS NULL OR cost_cents >= 0)
           AND pack_size > 0);

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_check CHECK (amount_cents >= 0);

ALTER TABLE refunds
  ADD CONSTRAINT refunds_amount_check CHECK (amount_cents >= 0);

ALTER TABLE invoices
  ADD CONSTRAINT invoices_sequence_check CHECK (sequence >= 1),
  ADD CONSTRAINT invoices_amounts_check
    CHECK (subtotal_cents >= 0 AND discount_cents >= 0 AND shipping_cents >= 0
           AND tax_gst_cents >= 0 AND tax_qst_cents >= 0 AND tax_hst_cents >= 0
           AND tax_pst_cents >= 0 AND total_cents >= 0);

ALTER TABLE invoice_counters
  ADD CONSTRAINT invoice_counters_last_value_check CHECK (last_value >= 0);

ALTER TABLE reviews
  ADD CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5);

ALTER TABLE coupons
  ADD CONSTRAINT coupons_percent_check
    CHECK (value_percent IS NULL OR value_percent BETWEEN 1 AND 100),
  ADD CONSTRAINT coupons_value_check
    CHECK (value_cents IS NULL OR value_cents >= 0);

ALTER TABLE replenishment_plans
  ADD CONSTRAINT replenishment_plans_interval_check CHECK (interval_days > 0),
  ADD CONSTRAINT replenishment_plans_quantity_check CHECK (quantity > 0);

ALTER TABLE supplier_products
  ADD CONSTRAINT supplier_products_cost_check CHECK (cost_cents >= 0 AND moq > 0);

ALTER TABLE ai_identifications
  ADD CONSTRAINT ai_identifications_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
