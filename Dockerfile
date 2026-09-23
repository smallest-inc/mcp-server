# syntax=docker/dockerfile:1

# ============================================
# Stage 1: build
# esbuild bundles src/http.ts and every dependency into a single dist/http.js,
# so the runtime stage needs no node_modules at all.
# ============================================
FROM node:22-alpine AS builder

WORKDIR /app

# Manifest first so the install layer survives source-only edits.
COPY package.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run type-check && npm run build:http

# ============================================
# Stage 2: runtime
# One bundled file. No package manager, no dependency tree, nothing from the
# build layers.
# ============================================
FROM node:22-alpine AS runtime

WORKDIR /app

# node:22-alpine ships an unprivileged `node` user; use it rather than root.
COPY --from=builder --chown=node:node /app/dist/http.js ./http.js

USER node

ENV NODE_ENV=production
ENV PORT=8092
EXPOSE 8092

CMD ["node", "http.js"]
