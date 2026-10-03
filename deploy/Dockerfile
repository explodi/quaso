# SPDX-License-Identifier: MIT
# The Quaso image (design §5.12): one binary, compiled with `bun build --compile` from the server
# and the website, on a distroless base, running as a non-root user with its data in /data.
# Build it from the repository's root: bun run docker

# --- Build: the website with Vite, then the server binary with the website inside.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN bun install --frozen-lockfile
RUN bun run build
# The data folder, owned by the runtime's non-root user (65532) when copied below.
RUN mkdir -p /out/data

# --- Run: glibc and nothing else; no shell, no package manager.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/dist/quaso /app/quaso
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATA_DIR=/data PORT=8000
EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["/app/quaso", "healthcheck"]
ENTRYPOINT ["/app/quaso"]
CMD ["serve"]
