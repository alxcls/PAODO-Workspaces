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

# Stage 2: production runner
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

RUN mkdir -p \
      /app/data \
      /app/provider-vault \
      /app/provider-key \
      /app/workspace-secret-vault \
      /app/workspace-secret-key && \
    chown -R node:node /app
USER node

ARG PORT=3000
EXPOSE ${PORT}
CMD ["npx", "tsx", "server.ts"]
