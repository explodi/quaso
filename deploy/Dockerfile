# SPDX-License-Identifier: MIT
# The Quaso image (design §5.12): one binary, compiled with `deno compile` from the server
# and the website, on a distroless base, running as a non-root user with its data in /data.
# Build it from the repository's root: deno task docker

# --- Build: the website with Vite, then the server binary with the website inside. It runs
# on the builder's own platform and cross-compiles, so a multi-platform build never emulates.
FROM --platform=$BUILDPLATFORM denoland/deno:2.9.6 AS build
ARG TARGETARCH
WORKDIR /src
COPY . .
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN deno install --frozen-lockfile
RUN deno task build:web
RUN case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu ;; \
      arm64) target=aarch64-unknown-linux-gnu ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    deno task build:server --target "$target"
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
