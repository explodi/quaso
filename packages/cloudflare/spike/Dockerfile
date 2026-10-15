# SPDX-License-Identifier: MIT
FROM denoland/deno:2.9.6@sha256:2014dc167ece617ef7e7ba40631ac2234c59e75ce693e7cc2dc2602b3c87859d
WORKDIR /spike
COPY server.ts .
EXPOSE 8000
ENTRYPOINT ["deno", "run", "-A", "server.ts"]
