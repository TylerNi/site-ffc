# SES : identités de domaine vérifiées par Easy DKIM, MAIL FROM aligné, TLS
# requis. La SORTIE DU BAC À SABLE est une demande de support manuelle (aucune
# ressource Terraform) — voir infra/README.md.

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = "ffc"

  delivery_options {
    tls_policy = "REQUIRE"
  }
  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_email_identity" "domain" {
  for_each               = var.domains
  email_identity         = each.value
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  for_each               = aws_sesv2_email_identity.domain
  email_identity         = each.value.email_identity
  mail_from_domain       = "mail.${each.value.email_identity}"
  behavior_on_mx_failure = "REJECT_MESSAGE"
}
