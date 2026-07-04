# Stage 1: build the Next.js app
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Docker CLI is required — the app spawns workspace containers via docker commands.
# git is required — workspace version history (snapshots) shells out to the `git` binary
# (lib/infra/git/gitClient.ts); node:*-alpine ships none, so without this every snapshot
# silently no-ops in production.
RUN apk add --no-cache docker-cli git

# Production dependencies + tsx (needed to run TypeScript server at runtime)
COPY package*.json ./
RUN npm ci --omit=dev && npm install tsx

# Next.js build output
COPY --from=builder /app/.next ./.next
COPY public/ ./public/

# Source files needed at runtime by tsx
COPY server.ts ./
COPY proxyEntry.ts ./
COPY next.config.ts ./
COPY tsconfig.json ./
COPY Dockerfile.workspace ./
COPY lib/ ./lib/
COPY app/ ./app/
COPY components/ ./components/

RUN mkdir -p /app/data && \
    chown -R node:node /app
USER node

ARG PORT=3000
EXPOSE ${PORT}
CMD ["npx", "tsx", "server.ts"]
