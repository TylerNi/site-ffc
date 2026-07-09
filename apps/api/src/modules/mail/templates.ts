import { type Locale } from '@ffc/core';

/**
 * Gabarits des courriels transactionnels de sécurité (tâche 05).
 *
 * Texte brut volontairement : délivrabilité maximale, aucun risque
 * d'injection HTML. La mise en forme de marque (HTML) viendra avec les
 * courriels de commande (tâche 12).
 *
 * IMPORTANT : les variables `secret` (liens contenant un jeton) ne sont
 * utilisées QUE pour le rendu — jamais persistées (voir MailService).
 */

export type MailTemplateKey =
  | 'email_verification'
  | 'password_reset'
  | 'password_changed'
  | 'new_device_login'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'account_deletion_request'
  | 'account_deleted'
  | 'admin_invitation'
  | 'order_confirmation'
  | 'order_payment_failed'
  | 'order_cancelled'
  | 'order_refunded'
  | 'order_shipped'
  | 'order_delivered';

export interface RenderedMail {
  subject: string;
  text: string;
  /** Version HTML (gabarits de commande, tâche 12). Absente = texte seul. */
  html?: string;
}

type Vars = Record<string, string>;

const SIGNATURE: Record<Locale, string> = {
  fr: "— L'équipe Filtration Montréal",
  en: '— The Furnace Filters Canada team',
};

const SECURITY_FOOTER: Record<Locale, string> = {
  fr: "Si vous n'êtes pas à l'origine de cette action, réinitialisez votre mot de passe immédiatement et contactez-nous.",
  en: 'If you did not perform this action, reset your password immediately and contact us.',
};

/**
 * Adresse physique de l'expéditeur — OBLIGATOIRE dans le pied des courriels
 * transactionnels. Ces courriels sont « transactionnels purs » (aucun
 * contenu marketing, aucun consentement requis, LCAP) : pas de lien de
 * désabonnement, mais l'identification de l'expéditeur reste de bon aloi.
 */
const COMPANY_POSTAL: Record<Locale, string> = {
  fr: 'Filtration Montréal inc. · 1234, rue Sainte-Catherine Est, bureau 200, Montréal (Québec) H2L 2G8, Canada',
  en: 'Filtration Montréal inc. · 1234 Sainte-Catherine St. E, Suite 200, Montreal, Quebec H2L 2G8, Canada',
};

const TRANSACTIONAL_NOTE: Record<Locale, string> = {
  fr: 'Courriel transactionnel lié à votre commande — envoyé même sans abonnement marketing.',
  en: 'Transactional email about your order — sent regardless of marketing preferences.',
};

/* ------------------------- Gabarit HTML maison ------------------------- */

const BRAND: Record<Locale, string> = {
  fr: 'Filtration Montréal',
  en: 'Furnace Filters Canada',
};

/**
 * Enveloppe HTML réutilisable des courriels de commande — sobre, compatible
 * clients de messagerie (styles en ligne, tableaux), avec bandeau de marque
 * et pied de page portant l'adresse physique. `bodyHtml` est déjà échappé
 * par l'appelant (le dispatcher).
 */
export function mailLayout(locale: Locale, heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8eb;">
        <tr><td style="background:#0f4c81;padding:20px 28px;">
          <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px;">${BRAND[locale]}</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1a1a1a;">${heading}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 28px;background:#fafbfc;border-top:1px solid #eef0f2;">
          <p style="margin:0 0 6px;font-size:12px;color:#8a9099;">${SIGNATURE[locale]}</p>
          <p style="margin:0 0 4px;font-size:11px;color:#a0a6ad;">${COMPANY_POSTAL[locale]}</p>
          <p style="margin:0;font-size:11px;color:#b4bac0;">${TRANSACTIONAL_NOTE[locale]}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Bouton HTML « appel à l'action » en ligne (compatible messageries). */
function button(url: string | undefined, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="border-radius:8px;background:#0f4c81;">
    <a href="${url ?? '#'}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">${label}</a>
  </td></tr></table>`;
}

/** Paragraphe HTML standard. */
function p(html: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#333;">${html}</p>`;
}

/** Bloc « récapitulatif » (encadré gris) — lignes + totaux déjà échappés. */
function summaryBox(innerHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;background:#fafbfc;border:1px solid #eef0f2;border-radius:8px;">
    <tr><td style="padding:16px 18px;font-size:13px;line-height:1.6;color:#333;">${innerHtml}</td></tr>
  </table>`;
}

const TEMPLATES: Record<MailTemplateKey, Record<Locale, (vars: Vars) => RenderedMail>> = {
  email_verification: {
    fr: (v) => ({
      subject: 'Confirmez votre adresse courriel',
      text:
        `Bonjour,\n\nPour activer votre compte, confirmez votre adresse en ouvrant ce lien (valide ${v.ttl}) :\n\n${v.verifyUrl}\n\n` +
        `Si vous n'avez pas créé de compte, ignorez ce courriel.\n\n${SIGNATURE.fr}`,
    }),
    en: (v) => ({
      subject: 'Confirm your email address',
      text:
        `Hello,\n\nTo activate your account, confirm your address by opening this link (valid ${v.ttl}):\n\n${v.verifyUrl}\n\n` +
        `If you did not create an account, you can ignore this email.\n\n${SIGNATURE.en}`,
    }),
  },
  password_reset: {
    fr: (v) => ({
      subject: 'Réinitialisation de votre mot de passe',
      text:
        `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valide ${v.ttl}, utilisable une seule fois) :\n\n${v.resetUrl}\n\n` +
        `Si vous n'avez pas demandé de réinitialisation, ignorez ce courriel : votre mot de passe reste inchangé.\n\n${SIGNATURE.fr}`,
    }),
    en: (v) => ({
      subject: 'Reset your password',
      text:
        `Hello,\n\nTo choose a new password, open this link (valid ${v.ttl}, single use):\n\n${v.resetUrl}\n\n` +
        `If you did not request a reset, ignore this email: your password is unchanged.\n\n${SIGNATURE.en}`,
    }),
  },
  password_changed: {
    fr: () => ({
      subject: 'Votre mot de passe a été modifié',
      text: `Bonjour,\n\nLe mot de passe de votre compte vient d'être modifié. Toutes les autres sessions ont été déconnectées.\n\n${SECURITY_FOOTER.fr}\n\n${SIGNATURE.fr}`,
    }),
    en: () => ({
      subject: 'Your password was changed',
      text: `Hello,\n\nThe password on your account was just changed. All other sessions have been signed out.\n\n${SECURITY_FOOTER.en}\n\n${SIGNATURE.en}`,
    }),
  },
  new_device_login: {
    fr: (v) => ({
      subject: 'Nouvelle connexion à votre compte',
      text:
        `Bonjour,\n\nUne connexion depuis un nouvel appareil vient d'avoir lieu :\n\n` +
        `  Appareil : ${v.device}\n  Adresse IP : ${v.ip}\n  Date : ${v.date}\n\n${SECURITY_FOOTER.fr}\n\n${SIGNATURE.fr}`,
    }),
    en: (v) => ({
      subject: 'New sign-in to your account',
      text:
        `Hello,\n\nA sign-in from a new device just occurred:\n\n` +
        `  Device: ${v.device}\n  IP address: ${v.ip}\n  Date: ${v.date}\n\n${SECURITY_FOOTER.en}\n\n${SIGNATURE.en}`,
    }),
  },
  mfa_enabled: {
    fr: () => ({
      subject: 'Authentification à deux facteurs activée',
      text: `Bonjour,\n\nL'authentification à deux facteurs (TOTP) vient d'être activée sur votre compte. Conservez vos codes de secours en lieu sûr.\n\n${SECURITY_FOOTER.fr}\n\n${SIGNATURE.fr}`,
    }),
    en: () => ({
      subject: 'Two-factor authentication enabled',
      text: `Hello,\n\nTwo-factor authentication (TOTP) was just enabled on your account. Keep your recovery codes somewhere safe.\n\n${SECURITY_FOOTER.en}\n\n${SIGNATURE.en}`,
    }),
  },
  mfa_disabled: {
    fr: () => ({
      subject: 'Authentification à deux facteurs désactivée',
      text: `Bonjour,\n\nL'authentification à deux facteurs vient d'être désactivée sur votre compte.\n\n${SECURITY_FOOTER.fr}\n\n${SIGNATURE.fr}`,
    }),
    en: () => ({
      subject: 'Two-factor authentication disabled',
      text: `Hello,\n\nTwo-factor authentication was just disabled on your account.\n\n${SECURITY_FOOTER.en}\n\n${SIGNATURE.en}`,
    }),
  },
  account_deletion_request: {
    fr: (v) => ({
      subject: 'Confirmez la suppression de votre compte',
      text:
        `Bonjour,\n\nNous avons reçu une demande de suppression de votre compte. Pour la confirmer, ouvrez ce lien (valide ${v.ttl}) :\n\n${v.confirmUrl}\n\n` +
        `Cette action est IRRÉVERSIBLE : vos données personnelles seront effacées (l'historique de commandes est conservé, anonymisé, pour la comptabilité — Loi 25).\n\n` +
        `Si vous n'avez rien demandé, ignorez ce courriel et changez votre mot de passe.\n\n${SIGNATURE.fr}`,
    }),
    en: (v) => ({
      subject: 'Confirm your account deletion',
      text:
        `Hello,\n\nWe received a request to delete your account. To confirm, open this link (valid ${v.ttl}):\n\n${v.confirmUrl}\n\n` +
        `This action is IRREVERSIBLE: your personal data will be erased (order history is kept, anonymized, for accounting — Quebec Law 25).\n\n` +
        `If you did not request this, ignore this email and change your password.\n\n${SIGNATURE.en}`,
    }),
  },
  account_deleted: {
    fr: () => ({
      subject: 'Votre compte a été supprimé',
      text: `Bonjour,\n\nVotre compte a été supprimé et vos données personnelles effacées, conformément à la Loi 25. Merci d'avoir été client de Filtration Montréal.\n\n${SIGNATURE.fr}`,
    }),
    en: () => ({
      subject: 'Your account has been deleted',
      text: `Hello,\n\nYour account has been deleted and your personal data erased, in accordance with Quebec Law 25. Thank you for having been a Furnace Filters Canada customer.\n\n${SIGNATURE.en}`,
    }),
  },
  admin_invitation: {
    fr: (v) => ({
      subject: 'Invitation à l’administration Filtration Montréal',
      text:
        `Bonjour,\n\n${v.inviter} vous invite à rejoindre l'administration de Filtration Montréal ` +
        `avec le ou les rôles : ${v.roles}.\n\nPour activer votre accès, choisissez un mot de passe ` +
        `en ouvrant ce lien (valide ${v.ttl}, utilisable une seule fois) :\n\n${v.acceptUrl}\n\n` +
        `Rappel de sécurité : l'accès à l'administration exige l'activation de la double ` +
        `authentification (MFA) après la définition de votre mot de passe.\n\n${SIGNATURE.fr}`,
    }),
    en: (v) => ({
      subject: 'Invitation to the Furnace Filters Canada admin',
      text:
        `Hello,\n\n${v.inviter} has invited you to join the Furnace Filters Canada admin ` +
        `with the following role(s): ${v.roles}.\n\nTo activate your access, choose a password ` +
        `by opening this link (valid ${v.ttl}, single use):\n\n${v.acceptUrl}\n\n` +
        `Security reminder: admin access requires enabling two-factor authentication (MFA) ` +
        `after you set your password.\n\n${SIGNATURE.en}`,
    }),
  },
  order_confirmation: {
    fr: (v) => ({
      subject: `Confirmation de commande ${v.orderNumber}`,
      text:
        `Bonjour,\n\nMerci pour votre commande ${v.orderNumber} ! Elle est confirmée et sera préparée sous peu.\n\n` +
        `Articles :\n${v.linesText}\n\nTotal payé : ${v.total}\n\n` +
        `Votre facture : ${v.invoiceUrl}\n\n` +
        `Vous recevrez un courriel avec le numéro de suivi dès l'expédition.\n\n${SIGNATURE.fr}`,
      html: mailLayout(
        'fr',
        `Merci pour votre commande ${v.orderNumber}`,
        p('Votre commande est <strong>confirmée</strong> et sera préparée sous peu.') +
          summaryBox(
            `${v.linesHtml}<div style="border-top:1px solid #eef0f2;margin-top:10px;padding-top:10px;font-weight:700;">Total payé : ${v.total}</div>`,
          ) +
          button(v.invoiceUrl, 'Télécharger la facture') +
          p('Vous recevrez un courriel avec le numéro de suivi dès l’expédition.'),
      ),
    }),
    en: (v) => ({
      subject: `Order confirmation ${v.orderNumber}`,
      text:
        `Hello,\n\nThank you for your order ${v.orderNumber}! It is confirmed and will be prepared shortly.\n\n` +
        `Items:\n${v.linesText}\n\nTotal paid: ${v.total}\n\n` +
        `Your invoice: ${v.invoiceUrl}\n\n` +
        `You will receive an email with the tracking number as soon as it ships.\n\n${SIGNATURE.en}`,
      html: mailLayout(
        'en',
        `Thank you for your order ${v.orderNumber}`,
        p('Your order is <strong>confirmed</strong> and will be prepared shortly.') +
          summaryBox(
            `${v.linesHtml}<div style="border-top:1px solid #eef0f2;margin-top:10px;padding-top:10px;font-weight:700;">Total paid: ${v.total}</div>`,
          ) +
          button(v.invoiceUrl, 'Download invoice') +
          p('You will receive an email with the tracking number as soon as it ships.'),
      ),
    }),
  },
  order_payment_failed: {
    fr: (v) => ({
      subject: `Paiement non abouti — commande ${v.orderNumber}`,
      text:
        `Bonjour,\n\nLe paiement de votre commande ${v.orderNumber} n'a pas abouti${v.reason ? ` (${v.reason})` : ''}.\n\n` +
        `Votre panier est conservé : vous pouvez réessayer avec un autre moyen de paiement ici :\n${v.retryUrl}\n\n${SIGNATURE.fr}`,
      html: mailLayout(
        'fr',
        'Votre paiement n’a pas abouti',
        p(
          `Le paiement de la commande <strong>${v.orderNumber}</strong> n’a pas pu être complété${v.reason ? ` (${v.reason})` : ''}.`,
        ) +
          p('Votre panier est conservé — vous pouvez réessayer avec un autre moyen de paiement.') +
          button(v.retryUrl, 'Reprendre le paiement'),
      ),
    }),
    en: (v) => ({
      subject: `Payment failed — order ${v.orderNumber}`,
      text:
        `Hello,\n\nThe payment for your order ${v.orderNumber} did not go through${v.reason ? ` (${v.reason})` : ''}.\n\n` +
        `Your cart is saved: you can try again with another payment method here:\n${v.retryUrl}\n\n${SIGNATURE.en}`,
      html: mailLayout(
        'en',
        'Your payment did not go through',
        p(
          `The payment for order <strong>${v.orderNumber}</strong> could not be completed${v.reason ? ` (${v.reason})` : ''}.`,
        ) +
          p('Your cart is saved — you can try again with another payment method.') +
          button(v.retryUrl, 'Retry payment'),
      ),
    }),
  },
  order_cancelled: {
    fr: (v) => ({
      subject: `Commande annulée ${v.orderNumber}`,
      text:
        `Bonjour,\n\nVotre commande ${v.orderNumber} a été annulée${v.refundAmount ? ` et un remboursement de ${v.refundAmount} a été émis` : ''}.\n\n` +
        `Le remboursement paraît sur votre relevé sous quelques jours ouvrables selon votre institution.\n\n${SIGNATURE.fr}`,
      html: mailLayout(
        'fr',
        `Commande ${v.orderNumber} annulée`,
        p(
          `Votre commande <strong>${v.orderNumber}</strong> a été annulée${v.refundAmount ? ` et un remboursement de <strong>${v.refundAmount}</strong> a été émis` : ''}.`,
        ) +
          p(
            'Le remboursement paraît sur votre relevé sous quelques jours ouvrables, selon votre institution financière.',
          ),
      ),
    }),
    en: (v) => ({
      subject: `Order cancelled ${v.orderNumber}`,
      text:
        `Hello,\n\nYour order ${v.orderNumber} has been cancelled${v.refundAmount ? ` and a refund of ${v.refundAmount} was issued` : ''}.\n\n` +
        `The refund will appear on your statement within a few business days depending on your bank.\n\n${SIGNATURE.en}`,
      html: mailLayout(
        'en',
        `Order ${v.orderNumber} cancelled`,
        p(
          `Your order <strong>${v.orderNumber}</strong> has been cancelled${v.refundAmount ? ` and a refund of <strong>${v.refundAmount}</strong> was issued` : ''}.`,
        ) +
          p(
            'The refund will appear on your statement within a few business days depending on your financial institution.',
          ),
      ),
    }),
  },
  order_refunded: {
    fr: (v) => ({
      subject: `Remboursement émis — commande ${v.orderNumber}`,
      text:
        `Bonjour,\n\nUn remboursement de ${v.refundAmount} a été émis pour votre commande ${v.orderNumber}.\n\n` +
        `${v.creditNoteUrl ? `Votre note de crédit : ${v.creditNoteUrl}\n\n` : ''}Il paraît sur votre relevé sous quelques jours ouvrables.\n\n${SIGNATURE.fr}`,
      html: mailLayout(
        'fr',
        'Remboursement émis',
        p(
          `Un remboursement de <strong>${v.refundAmount}</strong> a été émis pour la commande <strong>${v.orderNumber}</strong>.`,
        ) +
          (v.creditNoteUrl ? button(v.creditNoteUrl, 'Télécharger la note de crédit') : '') +
          p(
            'Il paraît sur votre relevé sous quelques jours ouvrables, selon votre institution financière.',
          ),
      ),
    }),
    en: (v) => ({
      subject: `Refund issued — order ${v.orderNumber}`,
      text:
        `Hello,\n\nA refund of ${v.refundAmount} has been issued for your order ${v.orderNumber}.\n\n` +
        `${v.creditNoteUrl ? `Your credit note: ${v.creditNoteUrl}\n\n` : ''}It will appear on your statement within a few business days.\n\n${SIGNATURE.en}`,
      html: mailLayout(
        'en',
        'Refund issued',
        p(
          `A refund of <strong>${v.refundAmount}</strong> has been issued for order <strong>${v.orderNumber}</strong>.`,
        ) +
          (v.creditNoteUrl ? button(v.creditNoteUrl, 'Download credit note') : '') +
          p('It will appear on your statement within a few business days depending on your bank.'),
      ),
    }),
  },
  order_shipped: {
    fr: (v) => ({
      subject: `Votre commande ${v.orderNumber} est expédiée`,
      text:
        `Bonjour,\n\nBonne nouvelle : votre commande ${v.orderNumber} est en route !\n\n` +
        `${v.carrier ? `Transporteur : ${v.carrier}\n` : ''}${v.trackingNumber ? `Numéro de suivi : ${v.trackingNumber}\n` : ''}${v.trackingUrl ? `Suivi : ${v.trackingUrl}\n` : ''}\n${SIGNATURE.fr}`,
      html: mailLayout(
        'fr',
        `Votre commande ${v.orderNumber} est en route`,
        p('Bonne nouvelle : votre commande a été remise au transporteur.') +
          (v.trackingNumber
            ? summaryBox(
                `${v.carrier ? `Transporteur : <strong>${v.carrier}</strong><br>` : ''}Numéro de suivi : <strong>${v.trackingNumber}</strong>`,
              )
            : '') +
          (v.trackingUrl ? button(v.trackingUrl, 'Suivre mon colis') : ''),
      ),
    }),
    en: (v) => ({
      subject: `Your order ${v.orderNumber} has shipped`,
      text:
        `Hello,\n\nGood news: your order ${v.orderNumber} is on its way!\n\n` +
        `${v.carrier ? `Carrier: ${v.carrier}\n` : ''}${v.trackingNumber ? `Tracking number: ${v.trackingNumber}\n` : ''}${v.trackingUrl ? `Tracking: ${v.trackingUrl}\n` : ''}\n${SIGNATURE.en}`,
      html: mailLayout(
        'en',
        `Your order ${v.orderNumber} is on its way`,
        p('Good news: your order has been handed to the carrier.') +
          (v.trackingNumber
            ? summaryBox(
                `${v.carrier ? `Carrier: <strong>${v.carrier}</strong><br>` : ''}Tracking number: <strong>${v.trackingNumber}</strong>`,
              )
            : '') +
          (v.trackingUrl ? button(v.trackingUrl, 'Track my package') : ''),
      ),
    }),
  },
  order_delivered: {
    fr: (v) => ({
      subject: `Votre commande ${v.orderNumber} est livrée`,
      text: `Bonjour,\n\nVotre commande ${v.orderNumber} a été livrée. Nous espérons que tout est conforme !\n\n${SIGNATURE.fr}`,
      html: mailLayout(
        'fr',
        `Votre commande ${v.orderNumber} est livrée`,
        p('Votre commande a été <strong>livrée</strong>. Nous espérons que tout est conforme !') +
          p('Une question ? Répondez simplement à ce courriel.'),
      ),
    }),
    en: (v) => ({
      subject: `Your order ${v.orderNumber} was delivered`,
      text: `Hello,\n\nYour order ${v.orderNumber} has been delivered. We hope everything is just right!\n\n${SIGNATURE.en}`,
      html: mailLayout(
        'en',
        `Your order ${v.orderNumber} was delivered`,
        p('Your order has been <strong>delivered</strong>. We hope everything is just right!') +
          p('Any questions? Just reply to this email.'),
      ),
    }),
  },
};

export function renderMail(key: MailTemplateKey, locale: Locale, vars: Vars): RenderedMail {
  return TEMPLATES[key][locale](vars);
}
