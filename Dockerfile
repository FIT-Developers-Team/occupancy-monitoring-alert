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
COPY scripts/requirements.txt ./scripts/requirements.txt
RUN pip install --no-cache-dir -r scripts/requirements.txt
COPY scripts/superset_to_duckdb.py ./scripts/superset_to_duckdb.py
CMD ["python3", "scripts/superset_to_duckdb.py", "--config", "config/superset-sync.json", "--daemon"]

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production
ENV WIOM_EMBEDDED_SYNC=1
ENV WIOM_SYNC_REQUIRED=1
ENV WIOM_API_SYNC_BOOTSTRAP=1
COPY --from=sync /usr/local /usr/local
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config ./config
COPY --from=build /app/db/schema.sql ./db/schema.sql
COPY --from=build /app/scripts/start-production.mjs ./scripts/start-production.mjs
COPY --from=build /app/scripts/superset_to_duckdb.py ./scripts/superset_to_duckdb.py
RUN python3 -c "import duckdb, pandas, requests"
# db/*.duckdb TIDAK di-copy — mount sebagai volume (lihat docker-compose.yml)
VOLUME ["/app/db", "/app/config"]
EXPOSE 3000
HEALTHCHECK --start-period=30s --interval=15s --timeout=5s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start"]
