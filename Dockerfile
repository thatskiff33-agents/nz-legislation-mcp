# syntax=docker/dockerfile:1
# Container image for remote (HTTP) mode. Base images are pinned by digest (updated by Dependabot).
#
# Build:  docker build -t nz-legislation-mcp .
# Run:    see docs/self-hosting.md (OAuth is required: the container binds 0.0.0.0).

# ---- Base: Node with the pinned pnpm (from package.json "packageManager") ----------------
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS base
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- Production dependencies only (a clean install, so no dev packages ship) -------------
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod

# ---- Build: compile TypeScript -------------------------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# ---- Runtime: distroless (no shell, no package manager), non-root ------------------------
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:8ad9cc935b7843c4024b7e1487b5ef472c354ea847b97c667023e2618552607e
WORKDIR /app
# Application files stay root-owned (read-only to the nonroot user that runs the server).
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
ENV NODE_ENV=production \
    LEGISLATION_NZ_HTTP_HOST=0.0.0.0 \
    LEGISLATION_NZ_HTTP_PORT=8080
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "dist/cli.js"]
CMD ["http"]

LABEL org.opencontainers.image.title="nz-legislation-mcp" \
      org.opencontainers.image.description="Unofficial MCP server for the New Zealand Legislation API (remote HTTP mode)" \
      org.opencontainers.image.source="https://github.com/thatskiff33-agents/nz-legislation-mcp" \
      org.opencontainers.image.licenses="Apache-2.0"
