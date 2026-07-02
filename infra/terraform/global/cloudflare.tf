# Cloudflare : zones des deux domaines PRÉPARÉES (sans bascule des NS, qui se
# fait au registraire en tâche 25). TLS strict, HTTPS forcé, WAF managé de base.
# On n'ajoute QUE des enregistrements non conflictuels (SES) — l'apex et www
# continuent de pointer vers BigCommerce jusqu'à la bascule.

resource "cloudflare_zone" "zone" {
  for_each   = var.domains
  account_id = var.cloudflare_account_id
  zone       = each.value
}

resource "cloudflare_zone_settings_override" "zone" {
  for_each = cloudflare_zone.zone
  zone_id  = each.value.id

  settings {
    ssl                      = "strict" # TLS strict jusqu'à l'origine
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    security_level           = "medium"
    brotli                   = "on"
  }
}

# WAF : déploiement du Cloudflare Managed Ruleset (nécessite un plan Pro+).
resource "cloudflare_ruleset" "waf_managed" {
  for_each = cloudflare_zone.zone
  zone_id  = each.value.id
  name     = "FFC WAF managé"
  kind     = "zone"
  phase    = "http_request_firewall_managed"

  rules {
    action = "execute"
    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9aee" # Cloudflare Managed Ruleset
    }
    expression  = "true"
    description = "Déployer le Cloudflare Managed Ruleset"
    enabled     = true
  }
}

# --- Enregistrements DNS pour SES ---

# 3 CNAME Easy DKIM par domaine. Les clés du for_each sont statiques
# (« en-0 »…), seules les valeurs (jetons) sont connues après apply.
locals {
  dkim_slots = merge([
    for locale in keys(var.domains) : {
      for i in [0, 1, 2] : "${locale}-${i}" => { locale = locale, index = i }
    }
  ]...)
}

resource "cloudflare_record" "ses_dkim" {
  for_each = local.dkim_slots
  zone_id  = cloudflare_zone.zone[each.value.locale].id
  name     = "${aws_sesv2_email_identity.domain[each.value.locale].dkim_signing_attributes[0].tokens[each.value.index]}._domainkey.${var.domains[each.value.locale]}"
  type     = "CNAME"
  content  = "${aws_sesv2_email_identity.domain[each.value.locale].dkim_signing_attributes[0].tokens[each.value.index]}.dkim.amazonses.com"
  proxied  = false
  ttl      = 1
  comment  = "SES Easy DKIM"
}

# MAIL FROM : MX + SPF sur le sous-domaine mail.<domaine> (n'affecte pas le
# courriel existant de l'apex).
resource "cloudflare_record" "ses_mail_from_mx" {
  for_each = var.domains
  zone_id  = cloudflare_zone.zone[each.key].id
  name     = "mail.${each.value}"
  type     = "MX"
  content  = "feedback-smtp.${var.aws_region}.amazonses.com"
  priority = 10
  ttl      = 1
  comment  = "SES MAIL FROM"
}

resource "cloudflare_record" "ses_mail_from_spf" {
  for_each = var.domains
  zone_id  = cloudflare_zone.zone[each.key].id
  name     = "mail.${each.value}"
  type     = "TXT"
  content  = "v=spf1 include:amazonses.com ~all"
  ttl      = 1
  comment  = "SES MAIL FROM SPF"
}

# DMARC en mode surveillance (p=none) pour démarrer sans risque de rejet.
resource "cloudflare_record" "dmarc" {
  for_each = var.domains
  zone_id  = cloudflare_zone.zone[each.key].id
  name     = "_dmarc.${each.value}"
  type     = "TXT"
  content  = "v=DMARC1; p=none; rua=mailto:${var.dmarc_rua}; fo=1"
  ttl      = 1
  comment  = "DMARC (surveillance)"
}
