# WIOM Control Tower — image produksi
# Semua stage runtime dipin ke Debian Bookworm. Menyalin Python dari tag
# `python:3.12-slim` (yang dapat berpindah ke Debian lebih baru) ke image Node
# Bookworm menyebabkan binary Python meminta GLIBC_2.38 yang tidak tersedia.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM ${PYTHON_IMAGE} AS sync
WORKDIR /app
RUN set -eux \
  && apt-get update \
  && apt-get install -y --no-install-recommends libssl3 openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/requirements.txt ./scripts/requirements.txt
RUN pip install --no-cache-dir -r scripts/requirements.txt
COPY scripts/superset_to_duckdb.py ./scripts/superset_to_duckdb.py
# The canonical schema must also live OUTSIDE /app/db: that path is a volume, so
# an empty mount hides the copy shipped there and the sync would then invent its
# own tables — losing the vw_sloc / vw_stock_latest views the dashboard reads.
COPY db/schema.sql ./scripts/schema.sql
# Verify SSL is importable — slim images can miss libssl3 at runtime, breaking
# all HTTPS requests from the sync worker with "SSL module is not available".
RUN python3 -c "import ssl; import duckdb, pandas, requests; print('ssl OK', ssl.OPENSSL_VERSION)"
CMD ["python3", "scripts/superset_to_duckdb.py", "--config", "config/superset-sync.json", "--daemon"]

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM sync AS web
WORKDIR /app
ENV NODE_ENV=production
ENV WIOM_EMBEDDED_SYNC=1
ENV WIOM_SYNC_REQUIRED=1
ENV WIOM_API_SYNC_BOOTSTRAP=1
# Next standalone already contains only the traced production dependencies.
# The final image starts from the Python sync stage, so Python is not copied
# into another base as one large duplicate layer. Only the Node executable is
# needed to run the standalone server and supervisor.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/config ./config
COPY --from=build /app/db/schema.sql ./db/schema.sql
COPY --from=build /app/scripts/start-production.mjs ./scripts/start-production.mjs
COPY --from=build /app/scripts/superset_to_duckdb.py ./scripts/superset_to_duckdb.py
RUN node --version \
  && python3 -c "import ssl, duckdb, pandas, requests; print('ssl', ssl.OPENSSL_VERSION)"
# db/*.duckdb TIDAK di-copy — mount sebagai volume (lihat docker-compose.yml)
VOLUME ["/app/db", "/app/config"]
EXPOSE 3000
HEALTHCHECK --start-period=30s --interval=15s --timeout=5s --retries=4 \
  CMD curl -fS http://127.0.0.1:3000/api/ready || exit 1
CMD ["node", "scripts/start-production.mjs"]
