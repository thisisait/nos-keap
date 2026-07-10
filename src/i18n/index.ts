/**
 * i18n — real cs/en localization (COMPLETION_PROPOSAL.md Phase 2).
 *
 * The language setting lives in localStorage ('app-language', kept in sync
 * with the per-user DB setting by Settings.tsx) and falls back to the
 * browser language. English is the fallback catalog.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import cs from './locales/cs.json';
import en from './locales/en.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { cs: { translation: cs }, en: { translation: en } },
    fallbackLng: 'en',
    supportedLngs: ['cs', 'en'],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'app-language',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
