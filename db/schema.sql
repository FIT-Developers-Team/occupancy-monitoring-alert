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

-- Dataset 705 (pergerakan stok / "Recent movements"): satu baris per
-- transaksi × produk × aksi, dengan SUM(inventory_quantity) sebagai qty.
--
-- Tabel lama `movement_history` memakai bentuk hipotetis (movement_id,
-- movement_type, movement_datetime) yang tidak pernah terisi data nyata — job
-- sync-nya selalu SKIPPED karena dataset-nya belum ada. Bentuk asli dataset
-- jauh lebih kaya (paket, status asal/tujuan, kategori, tipe produk, invoice),
-- dan tidak dapat dipetakan ke kolom lama tanpa membuang sebagian besarnya.
-- Karena itu tabelnya diganti, bukan ditambal: yang lama dibuang sekali di
-- sini, dan tidak ada lagi yang menulis ke sana.
DROP TABLE IF EXISTS movement_history;
CREATE TABLE IF NOT EXISTS movement_events (
  _synced_at TIMESTAMP,
  created_at TIMESTAMP,          -- inventory_created_at (patokan waktu kejadian)
  updated_at TIMESTAMP,          -- inventory_updated_at (watermark incremental)
  location_id INTEGER,           -- inventory_origin_location_id
  location_name VARCHAR,         -- origin_location_name
  invoice_number VARCHAR,        -- inventory_invoice_number (ID transaksi/task)
  product_id BIGINT,             -- inventory_product_id
  product_name VARCHAR,
  sku_number VARCHAR,            -- product_sku_number
  l1_category VARCHAR,           -- parent_category_name
  product_type VARCHAR,          -- product_type_name
  source_sloc VARCHAR,           -- from_rack_name
  destination_sloc VARCHAR,      -- to_rack_name
  action_raw VARCHAR,            -- inventory_action (mentah; distandarkan saat dibaca)
  operator_sign VARCHAR,         -- inventory_operator (+/- terhadap stok)
  from_package VARCHAR,          -- from_package_label
  to_package VARCHAR,            -- to_package_label
  from_status VARCHAR,           -- from_status_notes
  to_status VARCHAR,             -- to_status_notes
  operator VARCHAR,              -- inventory_created_by (nama pelaksana)
  qty DOUBLE                     -- SUM(inventory_quantity)
);

-- Dedupe pergerakan.
--
-- Job incremental menarik ulang jendela lookback pada setiap pass, dan sebuah
-- transaksi yang di-update di WMS akan muncul kembali dengan `updated_at` baru.
-- Tanpa view ini, satu kejadian yang sama bisa terhitung dua kali pada KPI
-- masuk/keluar. Kunci alaminya adalah seluruh kolom pengenal KECUALI
-- `updated_at`, `qty`, dan `_synced_at`; versi paling akhir yang menang.
CREATE OR REPLACE VIEW vw_movement AS
WITH keyed AS (
  SELECT *,
         md5(concat_ws('|',
             coalesce(CAST(location_id AS VARCHAR), ''),
             coalesce(invoice_number, ''),
             coalesce(CAST(product_id AS VARCHAR), ''),
             coalesce(action_raw, ''),
             coalesce(operator_sign, ''),
             coalesce(source_sloc, ''), coalesce(destination_sloc, ''),
             coalesce(from_package, ''), coalesce(to_package, ''),
             coalesce(from_status, ''), coalesce(to_status, ''),
             coalesce(operator, ''),
             coalesce(CAST(created_at AS VARCHAR), ''))) AS movement_uid
  FROM movement_events
)
SELECT * FROM keyed
QUALIFY row_number() OVER (
    PARTITION BY movement_uid
    ORDER BY updated_at DESC NULLS LAST, _synced_at DESC NULLS LAST
) = 1;

CREATE TABLE IF NOT EXISTS _sync_audit (
  job VARCHAR, mode VARCHAR, started_at TIMESTAMP, finished_at TIMESTAMP,
  rows_pulled BIGINT, rows_written BIGINT, watermark VARCHAR,
  status VARCHAR, message VARCHAR
);
CREATE TABLE IF NOT EXISTS _sync_state (
  job VARCHAR PRIMARY KEY, watermark VARCHAR, key_max VARCHAR, updated_at TIMESTAMP
);

-- DuckDB already creates zonemaps for every column. The dashboard workload is
-- dominated by scans, joins, and aggregates; ART indexes only help extremely
-- selective point lookups and keep a second persisted copy of their columns.
-- Drop the legacy stock indexes so every snapshot is cheaper to append and the
-- database stays small enough for a low-memory VPS.
DROP INDEX IF EXISTS idx_stock_synced_at;
DROP INDEX IF EXISTS idx_stock_location;
DROP INDEX IF EXISTS idx_stock_sloc;
DROP INDEX IF EXISTS idx_stock_product;
DROP INDEX IF EXISTS idx_stock_synced_loc;
DROP INDEX IF EXISTS idx_stock_status;
DROP INDEX IF EXISTS idx_stock_category;
DROP INDEX IF EXISTS idx_stock_handling;
DROP INDEX IF EXISTS idx_stock_synced_status;
DROP INDEX IF EXISTS idx_stock_loc_sloc;

-- Retain only the two selective indexes used for master upserts and direct
-- SLOC lookup. Hash joins and aggregate filters do not benefit from the other
-- legacy ART indexes.
CREATE INDEX IF NOT EXISTS idx_sloc_id ON master_sloc (sloc_id);
CREATE INDEX IF NOT EXISTS idx_sloc_code ON master_sloc (sloc_code);
DROP INDEX IF EXISTS idx_sloc_location;
DROP INDEX IF EXISTS idx_sloc_active;
DROP INDEX IF EXISTS idx_sloc_area;
DROP INDEX IF EXISTS idx_sloc_zone;
DROP INDEX IF EXISTS idx_sloc_storage;
DROP INDEX IF EXISTS idx_audit_job_started;
DROP INDEX IF EXISTS idx_audit_status;
DROP INDEX IF EXISTS idx_audit_finished;
DROP INDEX IF EXISTS idx_movement_datetime;
DROP INDEX IF EXISTS idx_movement_location;
DROP INDEX IF EXISTS idx_movement_product;
DROP INDEX IF EXISTS idx_count_date;
DROP INDEX IF EXISTS idx_count_sloc;

-- Turunan
-- Dataset master di produksi ber-grain rack×product (planogram) — dedupe ke 1 baris per rak.
-- Prioritas baris: active=true dulu, lalu sloc_id terkecil (deterministik).
-- Dedupe key is (location_id, sloc_code), not sloc_code alone. Rack codes are
-- only unique inside a warehouse: 31 codes are reused across sites, so
-- partitioning by the code by itself kept one rack and silently discarded its
-- namesakes in every other warehouse. That removed 30 active racks from the
-- occupancy denominators, heatmaps and alerts — BGO alone lost 26 of its 1,640.
-- Every query joins on (location_id, sloc_code); the view now matches.
CREATE OR REPLACE VIEW vw_sloc AS
SELECT *,
       regexp_replace(rack_zone, '[0-9]+$', '') AS zone,   -- SRA1 -> SRA
       coalesce(nullif(area, ''), split_part(sloc_code, '-', 1)) AS wh
FROM master_sloc
QUALIFY row_number() OVER (
    PARTITION BY location_id, sloc_code
    ORDER BY (CASE WHEN active THEN 0 ELSE 1 END), sloc_id
) = 1;

CREATE OR REPLACE VIEW vw_stock_latest AS
SELECT * FROM stock_history
WHERE _synced_at = (SELECT max(_synced_at) FROM stock_history);
