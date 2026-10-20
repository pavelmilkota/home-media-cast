# Stage 1 image: the API plus the built web UI in one container (ADR-0004).
# Base image pinned to an explicit tag (AGENTS.md); bump it deliberately.
ARG NODE_IMAGE=node:24.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN npm install -g pnpm@12.14.0
# The pnpm store is a build cache mount, so it does not become part of an image layer.
# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm -r build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/home-media-cast.sqlite
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Production dependencies of the API (and the shared package it imports) only. pnpm is
# installed and removed in the same step so it is not shipped in the runtime image.
RUN --mount=type=cache,target=/pnpm-store --mount=type=cache,target=/root/.npm --mount=type=cache,target=/root/.cache/pnpm \
    npm install -g pnpm@12.14.0 \
 && pnpm install --frozen-lockfile --prod --filter @home-media-cast/api... --store-dir /pnpm-store \
 && npm uninstall -g pnpm
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir /data && chown node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 8787
CMD ["node", "dist/main.js"]
