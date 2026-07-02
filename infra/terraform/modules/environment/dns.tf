# Enregistrements Cloudflare propres à l'environnement : validation du certificat
# ACM, puis le sous-domaine de l'API (proxifié, WAF + TLS strict jusqu'à l'ALB).
resource "cloudflare_record" "acm_validation" {
  for_each = {
    for o in aws_acm_certificate.api.domain_validation_options : o.domain_name => {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  }
  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.value
  ttl     = 1
  proxied = false
  comment = "Validation ACM ${var.environment}"
}

resource "cloudflare_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.api_domain
  type    = "CNAME"
  content = aws_lb.main.dns_name
  proxied = true
  ttl     = 1
  comment = "API ${var.environment} (proxy Cloudflare, TLS strict)"
}
