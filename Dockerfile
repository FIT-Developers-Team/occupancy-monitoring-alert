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
COPY config ./config
COPY config ./default-config
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

# Compose runs Python as a separate service, so its web image stays Node-only.
# Coolify still uses the final all-in-one `web` target below for deployments
# where one service must supervise both processes.
FROM ${NODE_IMAGE} AS web-runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WIOM_EMBEDDED_SYNC=0
ENV WIOM_SYNC_REQUIRED=0
ENV WIOM_RUNTIME_CONFIG_DIR=/app/db/runtime-config
ENV WIOM_BUNDLED_CONFIG_DIR=/app/default-config
ENV WIOM_REQUIRE_PERSISTENT_STORAGE=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/config ./config
COPY --from=build /app/config ./default-config
COPY --from=build /app/db/schema.sql ./db/schema.sql
COPY --from=build /app/scripts/start-production.mjs ./scripts/start-production.mjs
RUN set -eux \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf node_modules/@img node_modules/sharp \
           node_modules/typescript node_modules/@types \
           db/*.duckdb db/*.duckdb.wal \
  && node -e "require.resolve('duckdb'); console.log('duckdb binding OK')"
# /app/db WAJIB berupa penyimpanan permanen: history DuckDB, state alert, akun,
# DAN konfigurasi runtime (db/runtime-config) hidup di sana. Selama folder ini
# bertahan, semua yang disimpan admin selamat dari deploy ulang.
#
# Tidak ada instruksi VOLUME anonim. Hosting wajib memasang named volume/bind
# mount yang bernama tetap ke /app/db; readiness menolak filesystem container.
# /app/config lama boleh tetap terpasang pada upgrade pertama untuk migrasi.
EXPOSE 3000
HEALTHCHECK --start-period=30s --interval=15s --timeout=8s --retries=4 \
  CMD curl --fail-with-body --silent --show-error --max-time 7 http://127.0.0.1:3000/api/ready || exit 1
CMD ["node", "scripts/start-production.mjs"]

FROM sync AS web
WORKDIR /app
ENV NODE_ENV=production
ENV WIOM_EMBEDDED_SYNC=1
ENV WIOM_SYNC_REQUIRED=1
ENV WIOM_API_SYNC_BOOTSTRAP=1
ENV WIOM_RUNTIME_CONFIG_DIR=/app/db/runtime-config
ENV WIOM_BUNDLED_CONFIG_DIR=/app/default-config
ENV WIOM_REQUIRE_PERSISTENT_STORAGE=1
# Next standalone already contains only the traced production dependencies.
# The final image starts from the Python sync stage, so Python is not copied
# into another base as one large duplicate layer. Only the Node executable is
# needed to run the standalone server and supervisor.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/config ./config
COPY --from=build /app/config ./default-config
COPY --from=build /app/db/schema.sql ./db/schema.sql
COPY --from=build /app/scripts/start-production.mjs ./scripts/start-production.mjs
COPY --from=build /app/scripts/superset_to_duckdb.py ./scripts/superset_to_duckdb.py
# Drop build-only weight that Next's tracer still copies into standalone.
# The tracing excludes are intentionally limited to runtime data directories;
# external packages remain present and are verified before the image is sealed.
# @img/sharp is dead weight because no route uses next/image (~18 MB of libvips);
# typescript and @types are compile-time only (~9 MB).
RUN rm -rf node_modules/@img node_modules/sharp \
           node_modules/typescript node_modules/@types \
           db/*.duckdb db/*.duckdb.wal \
  && node -e "require.resolve('duckdb'); console.log('duckdb binding OK')" \
  && node --version \
  && python3 -c "import ssl, duckdb, pandas, requests; print('ssl', ssl.OPENSSL_VERSION)"
# db/*.duckdb TIDAK di-copy — mount sebagai volume (lihat docker-compose.yml)
# /app/db WAJIB berupa penyimpanan permanen: history DuckDB, state alert, akun,
# DAN konfigurasi runtime (db/runtime-config) hidup di sana. Selama folder ini
# bertahan, semua yang disimpan admin selamat dari deploy ulang.
#
# Tidak ada instruksi VOLUME anonim. Hosting wajib memasang named volume/bind
# mount yang bernama tetap ke /app/db; readiness menolak filesystem container.
# Seluruh state baru hanya punya satu destination persisten.
EXPOSE 3000
HEALTHCHECK --start-period=30s --interval=15s --timeout=8s --retries=4 \
  CMD curl --fail-with-body --silent --show-error --max-time 7 http://127.0.0.1:3000/api/ready || exit 1
CMD ["node", "scripts/start-production.mjs"]
