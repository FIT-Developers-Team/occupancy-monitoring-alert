# WIOM Control Tower — image produksi
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM python:3.12-slim AS sync
WORKDIR /app
COPY scripts/requirements.txt ./scripts/requirements.txt
RUN pip install --no-cache-dir -r scripts/requirements.txt
COPY scripts/superset_to_duckdb.py ./scripts/superset_to_duckdb.py
CMD ["python3", "scripts/superset_to_duckdb.py", "--config", "config/superset-sync.json", "--daemon"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config ./config
COPY --from=build /app/db/schema.sql ./db/schema.sql
COPY --from=build /app/scripts/start-production.mjs ./scripts/start-production.mjs
# db/*.duckdb TIDAK di-copy — mount sebagai volume (lihat docker-compose.yml)
EXPOSE 3000
CMD ["npm", "run", "start"]
