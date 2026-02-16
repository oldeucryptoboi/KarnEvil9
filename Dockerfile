# ── Stage 1: Builder ──────────────────────────────────────────────
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy dependency manifests first (cache layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schemas/package.json       packages/schemas/
COPY packages/journal/package.json       packages/journal/
COPY packages/permissions/package.json   packages/permissions/
COPY packages/memory/package.json        packages/memory/
COPY packages/tools/package.json         packages/tools/
COPY packages/planner/package.json       packages/planner/
COPY packages/plugins/package.json       packages/plugins/
COPY packages/kernel/package.json        packages/kernel/
COPY packages/metrics/package.json       packages/metrics/
COPY packages/scheduler/package.json     packages/scheduler/
COPY packages/swarm/package.json         packages/swarm/
COPY packages/api/package.json           packages/api/
COPY packages/browser-relay/package.json packages/browser-relay/
COPY packages/cli/package.json           packages/cli/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/

RUN pnpm build

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:20-slim AS runtime

RUN groupadd -r karnevil9 && useradd -r -g karnevil9 karnevil9

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

# Copy plugins and infra configs
COPY plugins/ plugins/
COPY infra/ infra/

# Create writable directories for runtime data
RUN mkdir -p journal sessions && chown -R karnevil9:karnevil9 journal sessions

EXPOSE 3100

USER karnevil9

ENTRYPOINT ["node", "packages/cli/dist/index.js", "server"]
