# Diagrammes entité-relation — base de données FFC

> Document GÉNÉRÉ par `pnpm --filter @ffc/api db:erd` — ne pas éditer à la main.
> Un diagramme par domaine fonctionnel ; conventions et décisions dans [database.md](./database.md).

Tables : 44 · Enums : 28

## Comptes et accès

```mermaid
erDiagram
  users {
    string id PK
    string email UK
    datetime email_verified_at "nullable"
    string password_hash "nullable"
    string first_name "nullable"
    string last_name "nullable"
    string phone "nullable"
    enum_UserRole role
    enum_UserStatus status
    enum_Locale locale
    boolean mfa_enabled
    string mfa_secret_enc "nullable"
    string mfa_pending_secret_enc "nullable"
    int mfa_last_used_step "nullable"
    string_array mfa_recovery_code_hashes
    int failed_login_count
    datetime locked_until "nullable"
    string stripe_customer_id UK
    string google_id UK
    string apple_id UK
    datetime anonymized_at "nullable"
    datetime deletion_requested_at "nullable"
    datetime last_login_at "nullable"
    datetime created_at
    datetime updated_at
  }
  addresses {
    string id PK
    string user_id FK
    string label "nullable"
    string first_name "nullable"
    string last_name "nullable"
    string company "nullable"
    string line1
    string line2 "nullable"
    string city
    string province
    string postal_code
    string country
    string phone "nullable"
    boolean is_default_shipping
    boolean is_default_billing
    datetime created_at
    datetime updated_at
  }
  user_devices {
    string id PK
    string user_id FK
    enum_DevicePlatform platform
    string push_token UK
    string device_name "nullable"
    string app_version "nullable"
    datetime last_seen_at
    datetime created_at
    datetime updated_at
  }
  refresh_tokens {
    string id PK
    string user_id FK
    string token_hash UK
    string family_id
    datetime expires_at
    datetime used_at "nullable"
    datetime revoked_at "nullable"
    string ip "nullable"
    string user_agent "nullable"
    datetime created_at
  }
  one_time_tokens {
    string id PK
    string user_id FK
    enum_OneTimeTokenPurpose purpose
    string token_hash UK
    datetime expires_at
    datetime used_at "nullable"
    string ip "nullable"
    string user_agent "nullable"
    datetime created_at
  }
  roles {
    string id PK
    string key UK
    string name_fr
    string name_en
    string description "nullable"
    boolean is_system
    datetime created_at
    datetime updated_at
  }
  permissions {
    string id PK
    string key UK
    string description "nullable"
    datetime created_at
  }
  role_permissions {
    string role_id PK,FK
    string permission_id PK,FK
    datetime created_at
  }
  user_role_assignments {
    string user_id PK,FK
    string role_id PK,FK
    string assigned_by_user_id FK
    datetime created_at
  }
  addresses }o--|| users : "user"
  user_devices }o--|| users : "user"
  refresh_tokens }o--|| users : "user"
  one_time_tokens }o--|| users : "user"
  role_permissions }o--|| roles : "role"
  role_permissions }o--|| permissions : "permission"
  user_role_assignments }o--|| users : "user"
  user_role_assignments }o--|| roles : "role"
  user_role_assignments }o--o| users : "assignedByUser"
```

## Catalogue

```mermaid
erDiagram
  brands {
    string id PK
    string slug UK
    string name
    string logo_url "nullable"
    boolean is_active
    datetime created_at
    datetime updated_at
  }
  categories {
    string id PK
    string parent_id FK
    int sort_order
    boolean is_active
    datetime created_at
    datetime updated_at
  }
  category_translations {
    string id PK
    string category_id FK
    enum_Locale locale
    string name
    string slug
    string description "nullable"
  }
  products {
    string id PK
    string brand_id FK
    string category_id FK
    enum_ProductStatus status
    boolean is_featured
    datetime created_at
    datetime updated_at
  }
  product_translations {
    string id PK
    string product_id FK
    enum_Locale locale
    string name
    string slug
    string short_description "nullable"
    string description "nullable"
    string meta_title "nullable"
    string meta_description "nullable"
  }
  product_variants {
    string id PK
    string product_id FK
    string sku UK
    string barcode "nullable"
    string nominal_label
    decimal nominal_width_in
    decimal nominal_height_in
    decimal nominal_depth_in
    decimal actual_width_in
    decimal actual_height_in
    decimal actual_depth_in
    int merv "nullable"
    int pack_size
    int price_cents
    int compare_at_price_cents "nullable"
    int cost_cents "nullable"
    enum_Currency currency
    int weight_grams "nullable"
    boolean is_active
    int position
    datetime created_at
    datetime updated_at
  }
  product_images {
    string id PK
    string product_id FK
    string variant_id FK
    string url
    string alt_fr "nullable"
    string alt_en "nullable"
    int width "nullable"
    int height "nullable"
    int position
    datetime created_at
  }
  inventory_levels {
    string id PK
    string variant_id UK,FK
    int quantity_on_hand
    int quantity_reserved
    int low_stock_threshold "nullable"
    datetime updated_at
  }
  inventory_movements {
    string id PK
    string variant_id FK
    enum_InventoryMovementType type
    int quantity
    string reason "nullable"
    string order_id "nullable"
    string created_by_user_id FK
    datetime created_at
  }
  categories }o--o| categories : "parent"
  category_translations }o--|| categories : "category"
  products }o--|| brands : "brand"
  products }o--o| categories : "category"
  product_translations }o--|| products : "product"
  product_variants }o--|| products : "product"
  product_images }o--|| products : "product"
  product_images }o--o| product_variants : "variant"
  inventory_levels }o--|| product_variants : "variant"
  inventory_movements }o--|| product_variants : "variant"
```

## Compatibilité équipements et IA

```mermaid
erDiagram
  equipment_models {
    string id PK
    string manufacturer
    string model_number
    enum_EquipmentKind kind
    string_array aliases
    string notes "nullable"
    datetime created_at
    datetime updated_at
  }
  model_filter_compatibility {
    string id PK
    string equipment_model_id FK
    string variant_id FK
    enum_CompatibilitySource source
    boolean is_verified
    string notes "nullable"
    datetime created_at
    datetime updated_at
  }
  user_equipment {
    string id PK
    string user_id FK
    string equipment_model_id FK
    string nickname "nullable"
    string custom_manufacturer "nullable"
    string custom_model_number "nullable"
    string photo_key "nullable"
    string installed_filter_variant_id FK
    datetime last_filter_change_at "nullable"
    datetime created_at
    datetime updated_at
  }
  ai_identifications {
    string id PK
    string user_id FK
    string user_equipment_id FK
    string image_key
    enum_AiIdentificationStatus status
    string provider "nullable"
    string model "nullable"
    json extraction "nullable"
    decimal confidence "nullable"
    string matched_equipment_model_id FK
    string failure_reason "nullable"
    string reviewed_by_user_id FK
    datetime reviewed_at "nullable"
    datetime purge_at "nullable"
    datetime purged_at "nullable"
    datetime created_at
    datetime updated_at
  }
  model_filter_compatibility }o--|| equipment_models : "equipmentModel"
  user_equipment }o--o| equipment_models : "equipmentModel"
  ai_identifications }o--o| user_equipment : "userEquipment"
  ai_identifications }o--o| equipment_models : "matchedEquipmentModel"
```

## Fournisseurs

```mermaid
erDiagram
  suppliers {
    string id PK
    string code UK
    string name
    string email "nullable"
    string phone "nullable"
    string website "nullable"
    int lead_time_days "nullable"
    int min_order_cents "nullable"
    enum_Currency currency
    string notes "nullable"
    boolean is_active
    datetime created_at
    datetime updated_at
  }
  supplier_products {
    string id PK
    string supplier_id FK
    string variant_id FK
    string supplier_sku "nullable"
    int cost_cents
    enum_Currency currency
    int moq
    boolean is_preferred
    datetime last_purchase_at "nullable"
    datetime created_at
    datetime updated_at
  }
  supplier_products }o--|| suppliers : "supplier"
```

## Ventes

```mermaid
erDiagram
  carts {
    string id PK
    string user_id FK
    string guest_token UK
    enum_CartStatus status
    enum_Currency currency
    datetime expires_at "nullable"
    datetime created_at
    datetime updated_at
  }
  cart_items {
    string id PK
    string cart_id FK
    string variant_id FK
    int quantity
    int added_at_price_cents "nullable"
    datetime created_at
    datetime updated_at
  }
  orders {
    string id PK
    string number UK
    string user_id FK
    string guest_email "nullable"
    enum_OrderStatus status
    enum_OrderChannel channel
    enum_Locale locale
    enum_Currency currency
    int subtotal_cents
    int discount_cents
    int shipping_cents
    int tax_gst_cents
    int tax_qst_cents
    int tax_hst_cents
    int tax_pst_cents
    int total_cents
    string cart_id UK,FK
    string coupon_id FK
    json shipping_address "nullable"
    json billing_address "nullable"
    string shipping_province "nullable"
    string customer_note "nullable"
    string internal_note "nullable"
    string ip_address "nullable"
    string user_agent "nullable"
    datetime placed_at
    datetime paid_at "nullable"
    datetime shipped_at "nullable"
    datetime delivered_at "nullable"
    datetime cancelled_at "nullable"
    datetime created_at
    datetime updated_at
  }
  order_items {
    string id PK
    string order_id FK
    string variant_id FK
    string product_id FK
    string sku
    string name_fr
    string name_en
    string nominal_label "nullable"
    int merv "nullable"
    int pack_size
    int quantity
    int unit_price_cents
    int discount_cents
    int subtotal_cents
    int tax_cents
    int total_cents
    datetime created_at
  }
  order_status_history {
    string id PK
    string order_id FK
    enum_OrderStatus from_status "nullable"
    enum_OrderStatus to_status
    string note "nullable"
    string changed_by_user_id FK
    datetime created_at
  }
  payments {
    string id PK
    string order_id FK
    enum_PaymentProvider provider
    enum_PaymentStatus status
    int amount_cents
    enum_Currency currency
    string external_id "nullable"
    string stripe_charge_id "nullable"
    string payment_method_type "nullable"
    string card_brand "nullable"
    string card_last4 "nullable"
    string receipt_url "nullable"
    string failure_code "nullable"
    string failure_message "nullable"
    datetime captured_at "nullable"
    datetime created_at
    datetime updated_at
  }
  refunds {
    string id PK
    string order_id FK
    string payment_id FK
    enum_PaymentProvider provider
    enum_RefundStatus status
    int amount_cents
    enum_Currency currency
    string reason "nullable"
    string external_id "nullable"
    string processed_by_user_id FK
    datetime created_at
    datetime updated_at
  }
  invoices {
    string id PK
    string order_id FK
    enum_InvoiceKind kind
    enum_InvoiceStatus status
    string series
    int sequence
    string number UK
    enum_Currency currency
    int subtotal_cents
    int discount_cents
    int shipping_cents
    int tax_gst_cents
    int tax_qst_cents
    int tax_hst_cents
    int tax_pst_cents
    int total_cents
    string refund_id UK,FK
    string pdf_key "nullable"
    datetime issued_at
    datetime voided_at "nullable"
    datetime created_at
  }
  invoice_counters {
    string series PK
    int last_value
    datetime updated_at
  }
  coupons {
    string id PK
    string code UK
    enum_CouponType type
    int value_cents "nullable"
    int value_percent "nullable"
    enum_Currency currency
    int min_subtotal_cents "nullable"
    datetime starts_at "nullable"
    datetime ends_at "nullable"
    int max_redemptions "nullable"
    int max_redemptions_per_user "nullable"
    int times_redeemed
    boolean is_active
    datetime created_at
    datetime updated_at
  }
  coupon_redemptions {
    string id PK
    string coupon_id FK
    string order_id FK
    string user_id FK
    int amount_discounted_cents
    datetime created_at
  }
  cart_items }o--|| carts : "cart"
  orders }o--o| carts : "cart"
  orders }o--o| coupons : "coupon"
  order_items }o--|| orders : "order"
  order_status_history }o--|| orders : "order"
  payments }o--|| orders : "order"
  refunds }o--|| orders : "order"
  refunds }o--o| payments : "payment"
  invoices }o--|| orders : "order"
  invoices }o--o| refunds : "refund"
  coupon_redemptions }o--|| coupons : "coupon"
  coupon_redemptions }o--|| orders : "order"
```

## Expédition

```mermaid
erDiagram
  shipments {
    string id PK
    string order_id FK
    string shipstation_order_id "nullable"
    string shipstation_shipment_id UK
    enum_Carrier carrier "nullable"
    string carrier_code "nullable"
    string service_code "nullable"
    string tracking_number "nullable"
    string tracking_url "nullable"
    enum_ShipmentStatus status
    string label_key "nullable"
    int cost_cents "nullable"
    enum_Currency currency
    int weight_grams "nullable"
    decimal length_cm "nullable"
    decimal width_cm "nullable"
    decimal height_cm "nullable"
    datetime shipped_at "nullable"
    datetime estimated_delivery_at "nullable"
    datetime delivered_at "nullable"
    datetime last_polled_at "nullable"
    datetime next_poll_at "nullable"
    datetime created_at
    datetime updated_at
  }
  shipment_events {
    string id PK
    string shipment_id FK
    enum_ShipmentStatus status "nullable"
    string code "nullable"
    string description "nullable"
    string location "nullable"
    datetime occurred_at
    json raw "nullable"
    string dedup_key "nullable"
    datetime created_at
  }
  shipment_events }o--|| shipments : "shipment"
```

## Rappels, notifications et avis

```mermaid
erDiagram
  replenishment_plans {
    string id PK
    string user_id FK
    string variant_id FK
    string user_equipment_id FK
    enum_ReplenishmentPlanStatus status
    int interval_days
    int quantity
    datetime next_reminder_at
    datetime last_reminded_at "nullable"
    string last_order_id "nullable"
    datetime created_at
    datetime updated_at
  }
  notification_preferences {
    string id PK
    string user_id FK
    enum_NotificationCategory category
    enum_NotificationChannel channel
    boolean enabled
    datetime consent_at "nullable"
    string consent_source "nullable"
    datetime created_at
    datetime updated_at
  }
  notifications {
    string id PK
    string user_id FK
    enum_NotificationCategory category
    enum_NotificationChannel channel
    enum_NotificationStatus status
    string template_key
    string destination "nullable"
    string subject "nullable"
    json payload "nullable"
    string order_id "nullable"
    string replenishment_plan_id FK
    string external_id "nullable"
    string failure_reason "nullable"
    datetime sent_at "nullable"
    datetime created_at
  }
  reviews {
    string id PK
    string product_id FK
    string user_id FK
    string order_item_id UK,FK
    string order_id FK
    int rating
    string title "nullable"
    string body "nullable"
    enum_Locale locale
    string author_name "nullable"
    boolean is_verified_purchase
    enum_ReviewStatus status
    string moderated_by_user_id FK
    datetime moderated_at "nullable"
    string moderation_note "nullable"
    string reply "nullable"
    datetime replied_at "nullable"
    datetime created_at
    datetime updated_at
  }
  notifications }o--o| replenishment_plans : "replenishmentPlan"
```

## Technique

```mermaid
erDiagram
  webhook_events {
    string id PK
    string source
    string external_id
    string type "nullable"
    json payload
    enum_WebhookEventStatus status
    int attempts
    datetime processed_at "nullable"
    string failure_reason "nullable"
    datetime received_at
  }
  audit_logs {
    string id PK
    string actor_type
    string actor_id "nullable"
    string actor_email "nullable"
    string action
    string entity_type "nullable"
    string entity_id "nullable"
    json before "nullable"
    json after "nullable"
    json metadata "nullable"
    string ip "nullable"
    string user_agent "nullable"
    datetime created_at
  }
  settings {
    string key PK
    json value
    string description "nullable"
    datetime updated_at
    datetime created_at
  }
```
