# SPDX-License-Identifier: MIT
# The Quaso image (design §5.12): one binary, compiled with `deno compile` from the server
# and the website, on a distroless base, running as a non-root user with its data in /data.
# Build it from the repository's root: deno task docker
#
# Base images are pinned by digest so a rebuild pulls the same bytes. Update a tag and its
# digest together (the Deno tag matches .dvmrc; the two distroless images move as a pair),
# taking the multi-platform index digest that `docker buildx imagetools inspect <image>:<tag>`
# prints first.

# --- Build: the website with Vite, then the server binary with the website inside. It runs
# on the builder's own platform and cross-compiles, so a multi-platform build never emulates.
FROM --platform=$BUILDPLATFORM denoland/deno:2.9.6@sha256:2014dc167ece617ef7e7ba40631ac2234c59e75ce693e7cc2dc2602b3c87859d AS build
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

# --- Run: glibc and libgcc_s, which is all the binary links; no OpenSSL (Deno uses rustls),
# no shell, no package manager. libgcc_s comes from the same distroless release's cc image.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS libgcc
FROM gcr.io/distroless/base-nossl-debian12:nonroot@sha256:be40c00dfabd86576d92666e87e406714d5618342de1a0c213ad232de255172e
COPY --from=libgcc /lib/*-linux-gnu/libgcc_s.so.1 /lib/
COPY --from=build /src/dist/quaso /app/quaso
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATA_DIR=/data PORT=8000
EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["/app/quaso", "healthcheck"]
ENTRYPOINT ["/app/quaso"]
CMD ["serve"]
