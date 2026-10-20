import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/kodi/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
