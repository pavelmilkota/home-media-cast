# Contributing

Thanks for your interest. This is a small, noncommercial hobby project, so keep changes focused.

## Before you start

- Open an issue first for anything bigger than a bug fix, so we agree on the approach.
- Read [AGENTS.md](AGENTS.md) (the project rules, also useful for humans) and the relevant
  [ADRs](docs/adr/). Security rules there are hard rules: no secrets in git or logs, Kodi stays on
  loopback, pasted URLs go through the SSRF check.
- Documentation, code comments and commit messages are in English. Mark anything you did not
  test by hand as "⚠️ unverified".

## Develop

```bash
npm i -g pnpm@12.14.0
pnpm install
pnpm verify    # lint, build, typecheck, test; must pass
```

New UI text goes through `t()` with the key added to all four locales
(`apps/web/src/i18n/locales`). New environment variables go into `.env.example`,
`compose.yaml` and [docs/environment.md](docs/environment.md).

## Pull requests

- One topic per PR, with tests. Use Conventional Commits (`feat:`, `fix:`, `docs:` ...).
- Do not commit personal data: addresses, hostnames, tokens, watch history.

## License of contributions

By submitting a contribution you agree that it is licensed under the project's
[PolyForm Noncommercial License 1.0.0](LICENSE).
