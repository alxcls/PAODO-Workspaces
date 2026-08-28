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

# Stage 2: development runner. Same topology as the production runner — socket proxy, credproxy
# sidecar, volume-subpath mounts — but with the source bind-mounted and Next compiling on demand.
# Dev dependencies stay installed (typescript, tailwind) because nothing is prebuilt here, and the
# image deliberately carries no source: docker-compose.dev.yml mounts the working tree over /app.
FROM node:22-trixie-slim AS dev
WORKDIR /app
RUN npm install -g npm@11.6.2
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ docker-cli git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
# Same `node` user as the production runner, and for the same reason the volumes require it: compose
# drops every capability, so root has no CAP_DAC_OVERRIDE to bypass the uid-1000 ownership the data
# and vault volumes were seeded with. .next is pre-created so its anonymous volume inherits that
# ownership too — Next writes there on every compile.
# The same mount points the production runner creates, for the same reason: Docker seeds a fresh
# named volume from the image path, so a directory missing here becomes a root-owned volume the
# node user cannot write. .next is added to that list because Next writes there on every compile.
RUN mkdir -p \
      /app/.next \
      /var/lib/paodo/data \
      /var/lib/paodo/data/.proxy-ca \
      /var/lib/paodo/provider-vault \
      /var/lib/paodo/provider-key \
      /var/lib/paodo/workspace-secret-vault \
      /var/lib/paodo/workspace-secret-key && \
    chown -R node:node /app /var/lib/paodo
USER node
CMD ["npx", "tsx", "server.ts"]

# Stage 3: production runner
FROM node:22-trixie-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Docker CLI is required — the app spawns workspace containers through the socket proxy. git is
# required by workspace version history. docker-cli comes from Debian's own repositories, without
# installing an unused Docker daemon.
RUN apt-get update && \
    apt-get install -y --no-install-recommends docker-cli git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Production dependencies, including the native SQLite addon and tsx runtime, already installed
# for the same Node/OS/architecture in the builder.
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Next.js build output
COPY --from=builder /app/.next ./.next
COPY public/ ./public/

# Source files needed at runtime by tsx
COPY server.ts ./
COPY next.config.ts ./
COPY tsconfig.json ./
COPY Dockerfile.workspace ./
COPY lib/ ./lib/
COPY app/ ./app/
COPY components/ ./components/
COPY scripts/ ./scripts/

# .proxy-ca is a mount point for its own volume: Docker seeds a fresh named volume from the image
# path, so this is what makes it node-owned rather than root-owned and unwritable.
RUN mkdir -p \
      /var/lib/paodo/data \
      /var/lib/paodo/data/.proxy-ca \
      /var/lib/paodo/provider-vault \
      /var/lib/paodo/provider-key \
      /var/lib/paodo/workspace-secret-vault \
      /var/lib/paodo/workspace-secret-key && \
    chown -R node:node /app /var/lib/paodo
USER node

ARG PORT=3000
EXPOSE ${PORT}
CMD ["npx", "tsx", "server.ts"]
