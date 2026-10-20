# ADR-0004 — Stack and structure

- **Status:** proposed (amended 2026-10-19: versions pinned, test runner changed)
- **Date:** 2026-10-19

| What | Choice | Why |
|---|---|---|
| Runtime | Node.js >= 22 (dev host: 24.18); pnpm 12.14.0; TypeScript 6.0.3 (pinned to what NestJS 12 samples use; npm `latest` is 7.x) | |
| Backend | NestJS 12.2.0 — ESM-only, Node >= 20 (verified via ctx7) | required by the brief, owner's experience |
| Frontend | React 19 + Vite + vite-plugin-pwa, TanStack Query | PWA, fast builds |
| Database | **SQLite** (WAL) through **Drizzle ORM 0.45.4 + better-sqlite3 13.0.3**; migrations generated with drizzle-kit 0.31.11 and committed in `apps/api/drizzle/`, applied at startup. better-sqlite3 ships prebuilt binaries inside the package (glibc and musl), so it needs no install script. Not chosen: Drizzle 1.0 RC with built-in `node:sqlite` (release candidate), Prisma (generator + engine, heavier) | one node, one household, backup = copy a file; PostgreSQL is an extra service and an extra backup script |
| Product repo layout | pnpm workspaces: `apps/api`, `apps/web`, `packages/shared` (DTO types, `StreamSource`) | shared types between front and back |
| Tests | Vitest 5 for api and web (NestJS 12 is ESM-only and its samples use Vitest; Jest was dropped), unplugin-swc for decorator metadata, Testing Library (web), a fake Kodi WS server for integration | |
| Validation | **Zod 4.6.7** schemas in `packages/shared`, applied with NestJS 12's built-in `StandardSchemaValidationPipe` (`@Body({ schema })`); the same schemas generate the OpenAPI request bodies, so docs cannot drift from validation |
| Quality | ESLint, Prettier, `tsc --noEmit`, OpenAPI via `@nestjs/swagger` 12 at `/api/docs` | required by the brief |
| CI | Forgejo repository; there is **no Actions runner on the homeserver by design** (homeserver AGENTS.md) → ⚠️ open question: GitHub Actions on the mirror, or a runner on the PC | |
| Deployment | Docker Compose on the PC, one container (api serves the built web), `network_mode: host`, image with an **explicit tag** | one process is simpler |

Versions are pinned (`save-exact`) and the lockfile is committed.
