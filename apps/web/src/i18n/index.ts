import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './locales/en.js';
import { pl } from './locales/pl.js';
import { ru } from './locales/ru.js';
import { uk } from './locales/uk.js';

export const resources = {
  en: { translation: en },
  pl: { translation: pl },
  uk: { translation: uk },
  ru: { translation: ru },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export { i18n };
