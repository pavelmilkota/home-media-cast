# Development

Needs Node >= 22 (developed on 24.18) and pnpm 12.14.0 (`npm i -g pnpm@12.14.0`).

```bash
pnpm install
pnpm verify          # lint, build, typecheck, test: must pass before every commit
```

`pnpm test` runs without building first (the api and web test configs resolve
`packages/shared` to its source). `pnpm typecheck` needs `pnpm build` first for the same
package; `pnpm verify` does it in the right order.

## Run locally

```bash
pnpm build
node apps/api/dist/main.js              # API + built web on :8787 (set DB_PATH to keep data elsewhere)
pnpm --filter @home-media-cast/web dev  # Vite dev server; proxies /api to 127.0.0.1:8787
```

The API reads the environment, **not** `.env` (Docker Compose reads `.env`). Export the
variables you need, or use `docker compose up -d --build`.

## Conventions

- Web routes live in `apps/web/src/router.tsx`; new screens get a route there, and specs that
  navigate use `renderApp({ url })`.
- Tests: Vitest for api and web; the api integration tests run the whole Nest app against
  `FakeKodiServer`, which checks method names against the recorded Kodi introspection.
- Validation: Zod schemas in `packages/shared`, applied with Nest's
  `StandardSchemaValidationPipe`.
- Database: after editing `apps/api/src/db/schema.ts`, run
  `pnpm --filter @home-media-cast/api exec drizzle-kit generate --name <what>` and commit the
  SQL in `apps/api/drizzle/`. Migrations run at startup.
- New dependencies: check the version against current docs (ctx7, npm), pin it exactly
  (`.npmrc` has `save-exact`), commit the lockfile. pnpm 12 fails installs on unreviewed
  build scripts; approve or deny them with `pnpm approve-builds`.
- English for docs, code comments and commit messages.

## Translations (web app)

The PWA speaks English, Polish, Ukrainian and Russian. The default is the device language
(`navigator.languages`, first supported match), else English; Settings → Language overrides it
and "Auto" goes back to the device. The choice is stored in `localStorage` (`hmc.lang`).

- Strings live in `apps/web/src/i18n/locales/{en,pl,uk,ru}.ts`. `en.ts` is the source: the other
  files are typed against it, so a missing key fails `typecheck`, and `locales.spec.ts` checks
  key parity, `{{placeholders}}` and plural forms.
- Use `const { t } = useTranslation()` in components and `i18n.t` in plain modules. Every visible
  text, `aria-label` and `placeholder` goes through `t()`. Interpolate whole sentences; never glue
  translated pieces together.
- Counts use i18next plurals (`key_one/_few/_many/_other`); Polish, Ukrainian and Russian need
  all four. Relative times use the `time.*` keys.
- Not translated: API error messages and Cinemeta titles/descriptions (they arrive in English).
- Adding a language: add it to `LOCALES` and `LOCALE_NAMES` in `state/language.ts`, create the
  locale file, and register it in `i18n/index.ts`.
- ⚠️ unreviewed: the Polish, Ukrainian and Russian texts are drafted and have not been read by a
  native speaker yet.
