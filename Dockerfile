# syntax=docker/dockerfile:1

# ---- builder ----
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Copy lockfile + workspace manifests first for maximal layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/admin/package.json apps/admin/
COPY apps/portal/package.json apps/portal/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Flatten the gateway + its prod dependencies into /app/out.
RUN pnpm deploy --filter=@helm/gateway --prod --legacy /app/out

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Build info surfaced by GET /version (docs/10) and the admin header status cluster.
# Read at runtime by readBuildInfo() from these env vars; injected here at build
# time via --build-arg (CI passes the package version + commit + timestamp; see
# .github/workflows/ci.yml). Defaults keep a bare `docker build` working.
ARG HELM_VERSION=unknown
ARG HELM_GIT_SHA=unknown
ARG HELM_BUILT_AT=unknown
ENV HELM_VERSION=$HELM_VERSION \
    HELM_GIT_SHA=$HELM_GIT_SHA \
    HELM_BUILT_AT=$HELM_BUILT_AT

# Non-root user; pre-create the mount dirs it must read/write.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin helm \
 && mkdir -p /app/config /app/data && chown -R helm:helm /app

COPY --from=builder --chown=helm:helm /app/out ./
# Admin SPA static assets. `pnpm deploy` only flattens the gateway package, so the
# built admin SPA must be copied explicitly to the path the gateway's static root
# (ADMIN_BUILD_ROOT = ./apps/admin/build, resolved from /app) expects — otherwise
# /admin 404s while /admin/api works.
COPY --from=builder --chown=helm:helm /app/apps/admin/build ./apps/admin/build
# Self-service portal SPA static assets (docs/12). Same reasoning as admin: the
# gateway serves it from PORTAL_BUILD_ROOT = ./apps/portal/build (resolved from
# /app); without this copy /portal 404s while /portal/api works. portal-static.ts
# also reads the built index.html at startup for the CSP script hash, so the HTML
# must be present in the image.
COPY --from=builder --chown=helm:helm /app/apps/portal/build ./apps/portal/build
# Ship the default config/*.yaml so the image boots standalone (CI smoke + first run).
# Safe to bake: providers.yaml references credentials by env-var NAME only, never a
# plaintext key (principle 7). Operators still override by mounting a volume at /app/config.
COPY --from=builder --chown=helm:helm /app/config ./config
USER helm
EXPOSE 8080

# Built-in health check hits /healthz (provided by the gateway).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HELM_PORT??'8080')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
