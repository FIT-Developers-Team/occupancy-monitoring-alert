-- ===========================================================================
-- WIOM v2 — Skema DuckDB history, selaras 1:1 dengan dataset Superset asli.
-- Ditulis oleh scripts/superset_to_duckdb.py (live) atau scripts/seed.mjs (demo).
-- Web app membaca READ-ONLY.
-- ===========================================================================

-- Dataset 2 (master lokasi/SLOC): location_id..rack_storage_name
CREATE TABLE IF NOT EXISTS master_sloc (
  sloc_id BIGINT,
  location_id INTEGER,
  location_name VARCHAR,
  latitude DOUBLE,
  longitude DOUBLE,
  sloc_code VARCHAR,           -- rack_name (mis. CBT-SRA1-14-15-L2-01)
  area VARCHAR,                -- kode WH (CBT/STL/PGS/...)
  rack_zone VARCHAR,           -- mis. SRA1 / MZE2 / CHA1
  aisle VARCHAR, bay VARCHAR, level VARCHAR, bin VARCHAR,
  active BOOLEAN,
  max_quantity DOUBLE,
  max_volume DOUBLE,           -- CBM
  storage_handling VARCHAR,    -- rack_storage_name (Ambient/Chiller/Frozen/Cool)
  _synced_at TIMESTAMP
);

-- Dataset 1 (stok per SLOC × produk): snapshot penuh tiap sync
CREATE TABLE IF NOT EXISTS stock_history (
  _synced_at TIMESTAMP,
  location_id INTEGER,
  sloc_code VARCHAR,           -- rack_name; boleh NULL utk status Lost
  product_id BIGINT,
  product_name VARCHAR,
  sku_number VARCHAR,
  l1_category VARCHAR,
  storage_handling VARCHAR,
  length DOUBLE, width DOUBLE, height DOUBLE,
  status VARCHAR,              -- Available | Bad | Lost
  stock_qty DOUBLE,            -- SUM(stock) mentah (bukan format 6.91k)
  sku_cbm DOUBLE,
  occupied_cbm DOUBLE
);

-- Opsional (fase berikut): movement & cycle count
CREATE TABLE IF NOT EXISTS movement_history (
  movement_id BIGINT, movement_type VARCHAR, movement_datetime TIMESTAMP,
  operator VARCHAR, source_sloc VARCHAR, destination_sloc VARCHAR,
  product_id BIGINT, product_name VARCHAR, qty DOUBLE, _synced_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cycle_count (
  count_id VARCHAR, count_date DATE, sloc_code VARCHAR,
  system_qty DOUBLE, physical_qty DOUBLE
);

CREATE TABLE IF NOT EXISTS _sync_audit (
  job VARCHAR, mode VARCHAR, started_at TIMESTAMP, finished_at TIMESTAMP,
  rows_pulled BIGINT, rows_written BIGINT, watermark VARCHAR,
  status VARCHAR, message VARCHAR
);
CREATE TABLE IF NOT EXISTS _sync_state (
  job VARCHAR PRIMARY KEY, watermark VARCHAR, key_max VARCHAR, updated_at TIMESTAMP
);

-- Turunan
-- Dataset master di produksi ber-grain rack×product (planogram) — dedupe ke 1 baris per rak.
-- Prioritas baris: active=true dulu, lalu sloc_id terkecil (deterministik).
CREATE OR REPLACE VIEW vw_sloc AS
SELECT *,
       regexp_replace(rack_zone, '[0-9]+$', '') AS zone,   -- SRA1 -> SRA
       coalesce(nullif(area, ''), split_part(sloc_code, '-', 1)) AS wh
FROM master_sloc
QUALIFY row_number() OVER (
    PARTITION BY sloc_code
    ORDER BY (CASE WHEN active THEN 0 ELSE 1 END), sloc_id
) = 1;

CREATE OR REPLACE VIEW vw_stock_latest AS
SELECT * FROM stock_history
WHERE _synced_at = (SELECT max(_synced_at) FROM stock_history);
