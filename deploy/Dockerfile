# SPDX-License-Identifier: MIT
# The Quaso image (design §5.12): Node runs the server's TypeScript as it is, next to the
# built website, on a distroless base, as a non-root user with its data in /data.
# Build it from the repository's root: npm run docker
#
# Base images are pinned by digest so a rebuild pulls the same bytes. Update a tag and its
# digest together (both Node versions match .nvmrc), taking the multi-platform index digest
# that `docker buildx imagetools inspect <image>:<tag>` prints first.

# --- Build: the website with Vite, then the files the server runs. Nothing here is
# platform-specific, so it runs on the builder's own platform and a multi-platform build
# never emulates.
FROM --platform=$BUILDPLATFORM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build
WORKDIR /src
COPY . .
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --no-audit --no-fund
RUN npm run build:web
# The server's packages without their tests, the website, and the links that resolve
# `@quaso/*` imports (the server has no other dependencies). The data folder is owned by
# the runtime's non-root user (65532) when copied below.
RUN mkdir -p /out/app/packages/web /out/app/node_modules/@quaso /out/data && \
    cp package.json /out/app/ && \
    for name in core service server; do \
      cp -r "packages/$name" /out/app/packages/ && \
      ln -s "../../packages/$name" "/out/app/node_modules/@quaso/$name"; \
    done && \
    cp -r packages/web/dist /out/app/packages/web/dist && \
    find /out/app/packages \( -name '*.test.ts' -o -name testdata \) -prune -exec rm -rf {} +

# --- Run: Node and glibc only; no shell, no package manager.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a51c5d631b90e1b298e17a88a307b77f0b959b47de942d033acce0c96be3fb83
COPY --from=build /out/app /app
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATA_DIR=/data PORT=8000
EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/packages/server/main.ts", "healthcheck"]
ENTRYPOINT ["/nodejs/bin/node", "/app/packages/server/main.ts"]
CMD ["serve"]
