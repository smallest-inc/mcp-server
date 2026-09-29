# syntax=docker/dockerfile:1

# ============================================
# Stage 1: build
# esbuild bundles src/http.ts and every dependency into a single dist/http.js,
# so the runtime stage needs no node_modules at all.
# ============================================
# Pinned by digest (the multi-arch index) so the same commit always builds on the
# same Node and Alpine patch; the tag stays for readability and Dependabot bumps
# both lines together.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

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
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime

WORKDIR /app

# The bundle is ESM. Without this the file only runs because Node >= 22.7
# auto-detects module syntax — pin the base to node:20-alpine, which the
# declared engines range allows, and every pod crash-loops at startup.
RUN printf '{"type":"module"}' > package.json

# The commit SHA, so Sentry can name the build that introduced an error.
# Empty by default, so a local or CI build reports no release rather than a
# made-up "unknown" one.
ARG GIT_SHA=
ENV SENTRY_RELEASE=$GIT_SHA

# node:22-alpine ships an unprivileged `node` user; use it rather than root.
COPY --from=builder --chown=node:node /app/dist/http.js ./http.js

USER node

ENV NODE_ENV=production
ENV PORT=8092
EXPOSE 8092

# --no-experimental-detect-module on purpose: without it Node >= 22.7 infers ESM
# from the syntax, so the package.json above would be decorative and a base
# image downgrade — which engines ">=20" permits — would be the thing that
# breaks, far from this file. With the flag, the declaration is load-bearing
# here and in CI.
CMD ["node", "--no-experimental-detect-module", "http.js"]
