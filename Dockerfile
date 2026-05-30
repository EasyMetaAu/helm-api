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

# Non-root user; pre-create the mount dirs it must read/write.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin helm \
 && mkdir -p /app/config /app/data && chown -R helm:helm /app

COPY --from=builder --chown=helm:helm /app/out ./
USER helm
EXPOSE 8080

# Built-in health check hits /healthz (provided by the gateway).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/gateway/dist/index.js"]
