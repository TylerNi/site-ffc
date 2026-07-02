import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { messages } from '@ffc/i18n';

const deviceLanguage = getLocales()[0]?.languageCode;

void i18n.use(initReactI18next).init({
  resources: {
    fr: { translation: messages.fr },
    en: { translation: messages.en },
  },
  lng: deviceLanguage === 'fr' ? 'fr' : 'en',
  fallbackLng: 'en',
  interpolation: {
    // React protège déjà contre l'injection.
    escapeValue: false,
  },
});

export default i18n;
