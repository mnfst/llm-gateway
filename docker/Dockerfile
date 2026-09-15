# Runtime is gcr.io/distroless/nodejs24-debian13 (no shell, no package
# manager, just node). Prod deps are staged on node:24-slim; the prod
# install uses --ignore-scripts so no native modules are compiled,
# which means the runtime's glibc version is invisible to node_modules.
# Build/dev stages stay on node:24-alpine — smallest base that still has
# a shell, which the build (turbo, nest) needs. All base images are
# pinned by digest.

# Stage 1: Install all dependencies (including dev deps) for the build.
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS deps
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund --loglevel=error

# Stage 2: Build the frontend + backend + shared bundles.
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/frontend packages/frontend
COPY packages/backend packages/backend
COPY packages/manifest packages/manifest
# Marks this bundle as a self-hosted build so the frontend reveals the
# version badge baked in at build time. Cloud CI builds never set this.
ENV VITE_MANIFEST_SELFHOSTED=true
RUN npx turbo build --filter=manifest-backend --filter=manifest-frontend --filter=manifest-shared

# Stage 3: Production dependencies only. npm ci runs with --ignore-scripts
# so nothing is compiled — all runtime deps are pure JS, making the glibc
# of this stage irrelevant to the final image. --omit=optional drops the
# platform-specific binaries that vite/rollup/esbuild ship as
# optionalDependencies; without it, npm hoists @esbuild/linux-x64 (a Go
# binary) into node_modules even though `--omit=dev` strips its parent,
# and CVE scanners then flag the embedded Go stdlib.
FROM node:24-slim@sha256:24dc26ef1e3c3690f27ebc4136c9c186c3133b25563ae4d7f0692e4d1fe5db0e AS prod-deps
WORKDIR /app
RUN mkdir -p /app/request-recordings
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --omit=optional --ignore-scripts \
           --prefer-offline --no-audit --no-fund --loglevel=error && \
    mkdir -p packages/backend/node_modules && \
    rm -rf node_modules/typescript node_modules/@types \
           node_modules/ts-node node_modules/acorn \
           node_modules/create-require node_modules/v8-compile-cache-lib && \
    find . -path "*/node_modules/@esbuild" -type d -exec rm -rf {} + 2>/dev/null; \
    find . -path "*/node_modules/@vitest" -type d -exec rm -rf {} + 2>/dev/null; \
    find . -path "*/node_modules/*" \( -name "*.map" -o -name "README*" \
      -o -name "LICENSE*" -o -name "CHANGELOG*" -o -name "*.txt" \
      -o -name "*.md" -o -name "Makefile" -o -name "*.gyp" -o -name "*.gypi" \
      -o \( -name "*.ts" ! -name "*.d.ts" \) \) -delete 2>/dev/null; \
    find . -path "*/node_modules/*" -type d \( -name "__tests__" -o -name "test" \
      -o -name "tests" -o -name "docs" -o -name "example" \
      -o -name "examples" -o -name ".github" \) -exec rm -rf {} + 2>/dev/null; \
    true

# Stage 4: Distroless runtime. Runs as the built-in `nonroot` user (UID
# 65532) by default. No shell, no apk/apt, minimal CVE surface.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="Manifest" \
      org.opencontainers.image.description="Open-source AI model router. Plug your agents into any provider and send each query to the right model." \
      org.opencontainers.image.url="https://manifest.build" \
      org.opencontainers.image.documentation="https://manifest.build/docs" \
      org.opencontainers.image.source="https://github.com/mnfst/llm-gateway" \
      org.opencontainers.image.vendor="MNFST Inc." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs24-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:b087b405441cd3e8eab9bd53ae3dd1c2b824e7ce13f25c5e9bb353fbdb3f4544"

ENV NODE_ENV=production
ENV BIND_ADDRESS=0.0.0.0
# Expose the distroless node binary on PATH so `node` in docker-compose
# healthchecks (and anything else invoked with a bare command name) resolves.
ENV PATH=/nodejs/bin:$PATH

COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules node_modules
COPY --from=prod-deps --chown=nonroot:nonroot /app/packages/backend/node_modules packages/backend/node_modules
COPY --from=prod-deps --chown=nonroot:nonroot /app/request-recordings /data/request-recordings
COPY --from=prod-deps --chown=nonroot:nonroot /app/package.json package.json
COPY --from=build --chown=nonroot:nonroot /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/backend/dist packages/backend/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/frontend/dist packages/frontend/dist
COPY --chown=nonroot:nonroot packages/shared/package.json packages/shared/
COPY --chown=nonroot:nonroot packages/backend/package.json packages/backend/
# The telemetry sender reads the canonical Manifest version from this
# file at boot. Without it, readManifestVersion() falls back to "unknown"
# and the sender ends up posting invalid semver to the ingest endpoint.
COPY --chown=nonroot:nonroot packages/manifest/package.json packages/manifest/

EXPOSE 2099

# Distroless has no shell; use exec-form and a JS-only check.
# `node` resolves via the PATH we set above. We read PORT at runtime so
# the healthcheck follows whatever port the backend is actually using —
# the default is 3001 to match the backend's own fallback, which keeps
# legacy installs (no PORT env) working without a compose-file update.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||'3001';fetch(`http://127.0.0.1:${p}/api/v1/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The distroless image's ENTRYPOINT is already ["/nodejs/bin/node"],
# so CMD only needs the script path.
CMD ["packages/backend/dist/main.js"]
