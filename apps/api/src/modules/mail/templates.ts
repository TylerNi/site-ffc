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
  | 'admin_invitation';

export interface RenderedMail {
  subject: string;
  text: string;
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
};

export function renderMail(key: MailTemplateKey, locale: Locale, vars: Vars): RenderedMail {
  return TEMPLATES[key][locale](vars);
}
