# SPDX-License-Identifier: MIT
FROM denoland/deno:2.9.6
WORKDIR /spike
COPY server.ts .
EXPOSE 8000
ENTRYPOINT ["deno", "run", "-A", "server.ts"]
