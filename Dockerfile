# Stage 1: build the Next.js app.
# Debian Trixie slim (glibc), not Alpine (musl), supports better-sqlite3's packaged Linux binaries;
# build tools remain available as a fallback for unsupported architectures.
FROM node:22-trixie-slim AS builder
WORKDIR /app
# Pin npm to match the version used locally to generate package-lock.json. The image's bundled
# npm drifts from the maintainer's local npm, and different npm majors lay out nested optional deps
# (e.g. Tailwind's oxide-wasm @emnapi packages) differently — so an npm-11 lock fails `npm ci` under
# npm 10 with "EUSAGE ... Missing from lock file".
RUN npm install -g npm@11.6.2
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
# Keep dependencies installed for this exact Node/OS/architecture, then trim dev-only packages
# before copying node_modules into the runner. This also avoids installing native addons twice.
RUN npm run build && npm prune --omit=dev

# Stage 2: what both runners must share. The dev and production runners differ only in where the
# app comes from — bind-mounted source versus a prebuilt copy — so everything else lives here and
# neither can drift from the other: same OS packages, same mount points, same user, same command.
FROM node:22-trixie-slim AS runtime-base
WORKDIR /app

# Docker CLI is required — the app spawns workspace containers through the socket proxy. git is
# required by workspace version history. docker-cli comes from Debian's own repositories, without
# installing an unused Docker daemon.
RUN apt-get update && \
    apt-get install -y --no-install-recommends docker-cli git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Every volume mount point, pre-created and owned by node. Docker seeds a fresh named volume from
# the image path, so a directory missing here becomes a root-owned volume the app cannot write —
# and compose drops every capability, leaving root no CAP_DAC_OVERRIDE to bypass it.
RUN mkdir -p \
      /var/lib/paodo/data \
      /var/lib/paodo/data/.proxy-ca \
      /var/lib/paodo/provider-vault \
      /var/lib/paodo/provider-key \
      /var/lib/paodo/workspace-secret-vault \
      /var/lib/paodo/workspace-secret-key && \
    chown -R node:node /app /var/lib/paodo
CMD ["npx", "tsx", "server.ts"]

# Stage 3: development runner. Carries no source — docker-compose.dev.yml mounts the working tree
# over /app — and keeps dev dependencies installed because nothing is prebuilt here.
FROM runtime-base AS dev
RUN npm install -g npm@11.6.2
# The same native-build fallback the builder carries, for the same unsupported-architecture case.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
# .next gets the same treatment as the state volumes above: it is an anonymous volume in the dev
# overlay, and Next writes there on every compile.
RUN mkdir -p /app/.next && chown -R node:node /app
USER node

# Stage 4: production runner. Last stage on purpose — a targetless `docker build` must produce this
# one, which is what a deployment does.
FROM runtime-base AS runner
ENV NODE_ENV=production

# Production dependencies, including the native SQLite addon and tsx runtime, already installed
# for the same Node/OS/architecture in the builder.
COPY --chown=node:node package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Next.js build output
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --chown=node:node public/ ./public/

# Source files needed at runtime by tsx
COPY --chown=node:node server.ts next.config.ts tsconfig.json Dockerfile.workspace ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node app/ ./app/
COPY --chown=node:node components/ ./components/
COPY --chown=node:node scripts/ ./scripts/
USER node

ARG PORT=3000
EXPOSE ${PORT}
