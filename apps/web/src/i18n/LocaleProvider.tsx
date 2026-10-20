import type { ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components/I18nProvider';
import { useLocale } from '../state/language.js';

/** Tells react-aria (and so HeroUI's built-in strings, dates and numbers) which language the app uses. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  return <I18nProvider locale={useLocale()}>{children}</I18nProvider>;
}
