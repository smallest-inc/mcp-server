# syntax=docker/dockerfile:1

# ============================================
# Stage 1: build
# esbuild bundles src/http.ts and every dependency into a single dist/http.js,
# so the runtime stage needs no node_modules at all.
# ============================================
FROM node:22-alpine AS builder

WORKDIR /app

# Manifest first so the install layer survives source-only edits.
COPY package.json package-lock.json ./
# npm ci, not npm install: the image is the artifact that reaches production, so
# it must resolve the same tree CI tested rather than whatever the ranges allow
# on the day it is built.
RUN npm ci --ignore-scripts

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

# The bundle is ESM. Without this the file only runs because Node >= 22.7
# auto-detects module syntax — pin the base to node:20-alpine, which the
# declared engines range allows, and every pod crash-loops at startup.
RUN printf '{"type":"module"}' > package.json

# node:22-alpine ships an unprivileged `node` user; use it rather than root.
COPY --from=builder --chown=node:node /app/dist/http.js ./http.js

USER node

ENV NODE_ENV=production
ENV PORT=8092
EXPOSE 8092

# --no-experimental-detect-module on purpose: without it Node >= 22.7 infers ESM
# from the syntax, so the package.json above would be decorative and a base
# image downgrade — which engines ">=18" permits — would be the thing that
# breaks, far from this file. With the flag, the declaration is load-bearing
# here and in CI.
CMD ["node", "--no-experimental-detect-module", "http.js"]
