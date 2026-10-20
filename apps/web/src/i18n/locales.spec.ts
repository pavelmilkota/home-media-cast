import { describe, expect, it } from 'vitest';
import { en } from './locales/en.js';
import { pl } from './locales/pl.js';
import { ru } from './locales/ru.js';
import { uk } from './locales/uk.js';

const flatten = (o: object, prefix = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...acc, [key]: v } : { ...acc, ...flatten(v, key) };
  }, {});

const source = flatten(en);
const placeholders = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();

describe.each([
  ['pl', pl],
  ['uk', uk],
  ['ru', ru],
])('%s locale', (code, messages) => {
  const flat = flatten(messages);

  it('has exactly the keys of English', () => {
    expect(Object.keys(flat).sort()).toEqual(Object.keys(source).sort());
  });

  it('keeps the same {{placeholders}} in every string', () => {
    for (const [key, text] of Object.entries(flat)) {
      expect(placeholders(text), key).toEqual(placeholders(source[key]!));
    }
  });

  it('has a plural form for every category the language uses', () => {
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const category of categories) {
      expect(flat[`cache.lists_${category}`], category).toBeTruthy();
    }
  });
});
