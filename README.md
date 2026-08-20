# FIT Occupancy Alert and Monitoring

Pemantauan okupansi, kapasitas, dan alert gudang — FIT · Astro.
Next.js 16 · Tailwind v4 (FIT Design System) · TypeScript · DuckDB · Chart.js · Google Chat/Email.

Menjawab tiga hal: **seberapa penuh (Qty & CBM), kapan penuh, pelanggaran apa yang terjadi** — dengan alert ber-siklus-hidup, bukan broadcast.

---

## 1. Quick Start (demo, 3 menit)

```bash
npm install
npm run seed        # data demo dari struktur & katalog Superset asli (8 site)
npm run build       # webpack (lihat §8)
npm run start       # http://localhost:3000
```

Untuk preview produksi di Windows tanpa membuat terminal/runner terus menunggu
output child process:

```powershell
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-preview.ps1 -Port 3105
```

Launcher akan selesai setelah HTTP merespons, sementara web tetap berjalan
terpisah di `http://localhost:3105`. Preview memakai `app_state` khusus per port
dan tidak menyalakan worker Superset kedua, sehingga aman saat port 3000 aktif.

| Login | Password | Role |
|---|---|---|
| `admin` | `FITwiom#2026` | semua + Pengaturan |
| `spv` | `FITspv#2026` | aksi alert |

Aplikasi hanya memiliki dua tampilan: **Admin View** dan **SPV View**. Akun baru
disimpan persisten di `db/runtime-config/accounts.json`; Admin membuka signup,
menyetujui/menolak pendaftaran SPV, atau membuat akun Admin/SPV langsung dari
**Pengaturan → Akun & Akses**.

Buka **Alert Center → Evaluasi sekarang**. Demo menanam: BIT 96%+ dengan SLOC over-qty, CBT basis CBM (master 1/1 → override), Bad di luar BADSTOCK (R13), stok Lost (R14), qty −6 (R11), phantom/ghost di cycle count.

Cara pakai lengkap: menu **Panduan** di aplikasi.

---

## 2. Arsitektur

```
Superset ──(scripts/superset_to_duckdb.py, 10 mnt)─► db/warehouse_history.duckdb ──READ-ONLY──► Next.js
                                                                                        │
                                              db/app_state.duckdb (alert/audit) ◄───────┘ satu-satunya penulis: web app
```

Dua file DuckDB, masing-masing **satu penulis**. Kebijakan (ambang, kapasitas, aturan, eskalasi, user) di `config/*.json` — diedit dari halaman Pengaturan, tercatat di Audit Trail.

---

## 3. Menghubungkan Superset → DB → Web

Dua dataset sumber (kolom persis seperti yang kamu kirim):

**Dataset MASTER LOKASI** → tabel `master_sloc`
`location_id, location_name, location_latitude, location_longitude, id (sloc), rack_name, area, zone, aisle, bay, level, bin, active, max_quantity, max_volume, rack_storage_name`

**Dataset STOK** → tabel `stock_history` (snapshot penuh tiap sync)
`location_id, product_id, product_name, sku_number, l1_category_name, rack_storage_name, length, width, height, rack_name, product_detail_status_name (Available/Bad/Lost), SUM(stock), sku_cbm, occupied_cbm`

Langkah (mode default `superset_dataset` — **tanpa SQL Lab, tanpa Google Sheet, tanpa kredensial DB**):

1. Jalankan web, masuk sebagai admin, lalu buka **Pengaturan → Superset Sync**.
2. Isi URL dan metode autentikasi. Kredensial disimpan di
   `config/.superset-sync.secrets.json` (diabaikan Git), tidak pernah dikirim
   kembali ke browser. Environment `SUPERSET_*` tetap dapat dipakai oleh secret
   manager dan selalu memiliki prioritas.
3. Isi **Dataset ID** dan opsional **Chart ID** untuk Master lokasi dan Snapshot
   stok. Mapping kolom dapat diedit langsung dari panel tiap dataset.
4. Tekan **Uji koneksi**. FIT Occupancy Alert and Monitoring memeriksa health, identitas akun, dan akses ke
   setiap dataset wajib tanpa menulis data.
5. Tekan **Sync sekarang**. Bila worker belum aktif, tombol berubah menjadi
   **Mulai & sync**: endpoint admin menjalankan preflight, memulai daemon,
   menunggu heartbeat, lalu mengantrekan sync. Request lama digunakan kembali
   agar satu klik tidak membuat dua full sync.
6. Untuk image web tunggal, worker Python sudah tertanam dan diawasi oleh
   `npm start`. Untuk Docker Compose, jalankan `docker compose up -d --build`;
   Compose memakai service `sync` terpisah dan menonaktifkan worker tertanam
   agar tidak ada dua penulis. Dependency Python dipasang saat build, bukan
   saat container restart.
7. Verifikasi `GET /api/ready` untuk kesiapan runtime/worker dan
   `GET /api/health` untuk kesehatan data. Pada `/api/health`,
   `snapshot_age_minutes` harus sesuai SLA operasional.

Konfigurasi publik berada di `config/superset-sync.json`. Filter allowlist
`location_id` dari delapan gudang selalu ditambahkan ke setiap job sehingga
lokasi HUB tidak ikut ditarik. Mode CLI tetap tersedia:

```bash
python3 scripts/superset_to_duckdb.py --config config/superset-sync.json
python3 scripts/superset_to_duckdb.py --config config/superset-sync.json --daemon
```

Status worker ditulis ke `db/.superset-sync-heartbeat.json` setiap 5 detik dan
segera diperbarui saat state berubah. Daemon memakai
`db/.superset-sync-daemon.lock`, sehingga supervisor startup dan fallback API
tidak dapat menghasilkan dua worker aktif.

Image produksi memakai `WIOM_SYNC_REQUIRED=1`: deployment gagal cepat bila
Python, dependency, konfigurasi, atau storage `db` tidak siap. Kredensial boleh
diisi sesudah startup melalui Pengaturan; fallback **Mulai & sync** memvalidasi
kredensial sebelum menerima request.
`WIOM_API_SYNC_BOOTSTRAP=1` mengaktifkan fallback **Mulai & sync** untuk platform
yang keliru menjalankan `next start` langsung. Deployment Node non-Docker tetap
perlu Python 3 dan `scripts/requirements.txt`; executable khusus dapat diatur
lewat `WIOM_SYNC_PYTHON`. `WIOM_EMBEDDED_SYNC=0` hanya dipakai bila worker
dijalankan sebagai service terpisah.

Pada deployment single-image, pasang **satu storage persisten bernama tetap** ke
`/app/db`. Folder ini memuat database, SESSION_SECRET persisten, akun,
konfigurasi Settings, webhook, dan kredensial Superset. `/app/config` bukan lagi
storage aktif; ia hanya dibaca untuk migrasi deployment lama. Default versi
aplikasi yang tidak boleh tertutup volume disimpan di `/app/default-config`.

Untuk Coolify berbasis Dockerfile, konfigurasi satu kali di **Configuration →
Persistent Storage → Add → Volume Mount**: isi nama misalnya `wiom-data`,
biarkan Source Path kosong, dan isi Destination Path `/app/db`, lalu redeploy.
Gunakan volume resource yang sama pada setiap update dan jangan mengaktifkan
cleanup unused volumes untuk volume produksi. Untuk instalasi yang sudah punya
mount `/app/config`, pertahankan mount itu pada **upgrade pertama** agar isi lama
dimigrasikan; setelah `db/runtime-config/` terisi dan backup diverifikasi, mount
legacy tersebut tidak lagi diperlukan.

### Upgrade Coolify tanpa kehilangan konfigurasi lama

Sebelum menambahkan atau mengganti mount pada aplikasi yang sudah berjalan,
periksa container lama dari terminal server. Perintah berikut hanya membaca
metadata dan nama berkas; ia tidak menampilkan isi secret:

```bash
docker inspect CONTAINER_LAMA --format '{{json .Mounts}}'
docker exec CONTAINER_LAMA sh -lc 'find /app/db/runtime-config -maxdepth 1 -type f -printf "%f\n" 2>/dev/null | sort'
```

- Bila `/app/db` sudah menunjuk ke Docker volume/bind mount, gunakan kembali
  source volume yang sama di Coolify; jangan membuat volume kosong baru.
- Bila `/app/db` tidak mempunyai mount, konfigurasi masih berada di writable
  layer container lama. Backup **sebelum** container itu dihapus, misalnya
  `docker cp CONTAINER_LAMA:/app/db /root/wiom-db-before-volume` dan, bila ada,
  `docker cp CONTAINER_LAMA:/app/config /root/wiom-config-before-volume`.
- Setelah backup aman, pasang Volume Mount Coolify bernama tetap ke `/app/db`,
  pulihkan data lama ke volume tersebut, baru redeploy. Menambahkan mount kosong
  langsung akan menutupi folder `/app/db` yang berada di image/container.

Healthcheck image memakai `curl --fail-with-body` ke `/api/ready`. Jika gagal,
body JSON sekarang terlihat di deployment log. Kode
`PERSISTENT_STORAGE_MISSING` berarti aplikasi dan worker sudah hidup, tetapi
Coolify belum memasang storage eksternal ke `/app/db`; guard ini sengaja tidak
diturunkan karena melewatinya akan membuat Settings kembali hilang saat rolling
update.

Pesan `auth.mode='cookie' tetapi cookie kosong` tidak membuat proses web mati,
tetapi sync data tidak akan berhasil. Setelah volume terpasang, isi melalui
**Pengaturan → Superset Sync** (tersimpan di `db/runtime-config`) atau environment
`SUPERSET_COOKIE_HEADER`/`SUPERSET_SESSION_COOKIE`. Pesan `CRON_SECRET belum
diisi` juga bukan kegagalan healthcheck, tetapi evaluasi alert terjadwal tetap
nonaktif sampai secret tersebut dikonfigurasi.

Untuk Coolify self-hosted, buka **Servers → localhost → Advanced → Builds** dan
atur **Deployment timeout (sec)** minimal `1800` (`3600` dianjurkan). Nilai ini
membatasi keseluruhan job deployment, termasuk kompilasi dan ekspor layer Docker;
nilai `360` dapat memutus build sehat dengan `exit code 255` saat `exporting
layers`. Biarkan build cache aktif dan matikan **Include Source Commit in Build**
agar layer dependency dapat digunakan kembali pada redeploy berikutnya.

Zona diturunkan otomatis: `SRA1 → SRA` (view `vw_sloc`). Baris **Lost tanpa lokasi** ikut tersinkron (kunci paging memakai `coalesce(rack_name,'~LOST')`) dan memicu R14.

---

## 4. Okupansi Qty & CBM (kebijakan)

Setiap SLOC dinilai dengan **satu basis kebijakan**: `pct = qty/max_qty` atau `cbm/(max_volume × utilisasi)`. Diatur di **Pengaturan → Kapasitas (Qty/CBM)**:

> **Kapasitas CBM yang tampil adalah kapasitas *efektif*.** Utilisasi volume
> hanya mengalikan basis CBM, tidak pernah basis Qty. Contoh: `max_cbm 0,0336`
> dengan utilisasi `85%` tampil sebagai `0,029 m³` — itu 0,0336 × 0,85, bukan
> konfigurasi yang gagal tersimpan. Nilai konfigurasinya ditampilkan berdampingan
> pada popup detail SLOC (heatmap dan Penjelajah SLOC), pada catatan “Standar
> kapasitas yang berlaku” di setiap halaman okupansi, dan sebagai kolom
> `Max CBM (konfigurasi)` + `Utilisasi volume (%)` di ekspor Excel.

| Lapisan | Isi |
|---|---|
| Default | basis, utilisasi %, status yang dihitung (Available/Bad/Lost), kategori dikecualikan |
| Aturan override (berurutan, bawah menimpa) | scope `WH · Zona (SRA/SRA1) · Storage · Kategori` → set `basis / max_qty / max_cbm / utilisasi` |
| Aturan kategori | hanya `Hitung ya/tidak` (kategori milik stok, bukan lokasi) |

Kenapa perlu override: master **CBT & STL `max 1/1` per bin**, **SRG `max_volume 1`** — angka mentah ini tidak layak dipakai langsung, jadi demo menetapkan CBT/STL → CBM dengan kapasitas efektif 3.0/2.5 m³, SRG → Qty. Sesuaikan dengan angka rak sebenarnya.

Switch **Kebijakan/Qty/CBM/Bin** di topbar mengubah metrik, bar, dan warna yang ditampilkan. **Status okupansi mengikuti basis tampilan; alert dievaluasi pada kedua basis kapasitas** (lihat §Alert) agar eskalasi tidak berubah hanya karena seorang pengguna mengganti view.

Tangga status memakai satu bahasa warna di seluruh aplikasi — lencana, bar
okupansi, sel heatmap, KPI, dan papan alert:

| Status | Warna | Severity alert yang sepadan |
|---|---|---|
| Normal | Hijau | `INFO` |
| Monitor | Biru | `WARNING` |
| Warning | Kuning | `HIGH` |
| Critical | Oranye | `CRITICAL` |
| Breach | Merah | `EMERGENCY` |

Setiap pasangan latar/teks diverifikasi ≥ 4,5:1 (WCAG AA) di tema terang dan
gelap. Monitor memakai keluarga *sky*, bukan biru FIT `--accent`: satu-satunya
hal lain yang berwarna biru FIT adalah elemen yang bisa diklik. Breach juga
diberi arsir diagonal pada lencana dan sel heatmap sebagai penanda kedua di luar
warna.

---

## 5. Fitur

Ringkasan Eksekutif (KPI Qty & CBM, tren operasional 48 jam, Top Risiko) · Okupansi per gudang/zona · Heatmap SLOC + drawer isi produk & movement · Forecast time-to-full (laju %, Qty & SKU/jam) + What-If Inbound/Outbound · Penjelajah SLOC (cari & filter lintas 144k lokasi) + ekspor Excel · Alert Center (dedup, hysteresis, auto-resolve, eskalasi dinamis, notifikasi real-time Google Chat per WH) · Integritas (phantom/ghost) · Audit Trail · Pengaturan 4 tab termasuk Superset Sync · Panduan · sidebar ⇄ icon-rail smooth + drawer mobile · ⌘K.

### 5.1 Filter, pencarian, dan ekspor Excel

Setiap tabel yang berhubungan dengan SLOC dan zona memakai satu kontrak filter
(`lib/sloc-filter.ts`) yang dibaca bersama oleh halaman, endpoint JSON, dan
endpoint ekspor. Konsekuensinya disengaja: **berkas Excel selalu berisi tepat
baris yang sedang tampil di layar — seluruhnya, dalam satu berkas, tanpa
paginasi atau pembagian batch.**

| Halaman | Filter & pencarian | Ekspor |
| --- | --- | --- |
| Lokasi Prioritas (`/density`) | Penjelajah SLOC penuh: pencarian bebas, gudang, zona, zona rak, penyimpanan, status, terisi/kosong, rentang %, basis tampilan. Filter tersimpan di URL. | `dataset=sloc` |
| Okupansi (`/occupancy`) | Filter zona (pencarian, gudang, status, terisi/kosong) + penjelajah SLOC | `dataset=zone`, `dataset=warehouse`, `dataset=sloc` |
| Detail gudang (`/occupancy/[wh]`) | Idem, terkunci pada satu gudang | `dataset=sloc` |
| Isi zona (`/occupancy/[wh]/[zone]`) | Pencarian SLOC/SKU, status stok, kategori L1, zona rak + penjelajah SLOC untuk lokasi kosong | `dataset=zone-detail`, `dataset=sloc` |
| Heatmap (`/heatmap`) | Pencarian zona, lompat ke kode SLOC, filter status pada legenda + penjelajah SLOC | `dataset=sloc` (termasuk per zona dari dialog) |
| Alert (`/alerts`) | Pencarian judul/lokasi/SKU/aturan, gudang, tingkat, aturan | `dataset=alerts` |
| Integritas (`/integrity`) | Pencarian kode SLOC, jenis selisih, gudang | `dataset=integrity` |
| Proyeksi (`/forecast`) | — | `dataset=forecast` |

Endpoint: `GET /api/export?dataset=<nama>&<filter>` mengembalikan `.xlsx` asli
(ditulis tanpa dependensi oleh `lib/xlsx.ts`) berisi sheet data + sheet
**Filter** yang mencatat kriteria, jumlah baris, dan waktu pembuatan sehingga
setiap berkas dapat diaudit ulang. Data tabel interaktif berasal dari
`GET /api/sloc/explore`, pilihan dropdown dari `GET /api/sloc/facets`.

Batas pengaman: 400.000 baris SLOC, 200.000 baris isi zona, 50.000 alert —
semuanya jauh di atas volume nyata (±144k SLOC aktif) sehingga tidak pernah
memaksa unduhan bertahap.

Dua trigger aktif: **OCC-ZONE-BREACH** (satu alert per warehouse/zona) dan
**OCC-SLOC-BREACH** (lokasi terparah, dibatasi `sloc_alerts.max_alerts` per pass).
Keduanya memakai hysteresis, auto-resolve, dedup thread, dan eskalasi sampai
di-ack. Rule stok dan movement dinonaktifkan sampai dataset movement tersedia.

### Tingkat keparahan: dinilai pada KEDUA basis kapasitas

Okupansi punya dua pengukuran independen — unit (Qty) dan volume (CBM). Berapa
banyak di antaranya yang melewati kapasitas itulah yang menentukan tingkat
keparahannya:

| Kondisi | Severity | Warna |
|---|---|---|
| Qty **dan** CBM melebihi kapasitas | `EMERGENCY` | Breach (merah) |
| Qty **atau** CBM melebihi kapasitas, keduanya terukur | `CRITICAL` | Critical (oranye) |
| Melebihi kapasitas, tetapi hanya satu basis yang punya kapasitas sahih | `CRITICAL` | Critical (oranye) |
| Melewati ambang breach, belum ada basis yang melebihi kapasitas | `HIGH` | Warning (kuning) |

Alasannya: satu basis melewati kapasitas masih bisa berarti angka kapasitas
master pada basis itu yang salah. Qty **dan** CBM sama-sama lewat tidak punya
penjelasan seperti itu — dua pengukuran independen sepakat lokasinya memang
penuh, dan itu memerlukan tindakan yang berbeda.

Baris ketiga adalah kasus ambigu: bila basis lainnya belum punya kapasitas,
kondisi "keduanya lewat" tidak akan pernah dapat dibuktikan, sehingga menaikkan
ke Breach berarti menghukum lubang di data master, bukan kondisi gudang.
Detail alert menyebut hal ini dan mengarahkan admin melengkapi kapasitasnya.

Keempat baris dapat diatur di **Pengaturan → Ambang → Tingkat keparahan
kelebihan kapasitas**, termasuk batas "melebihi kapasitas" (bawaan 100%).

Catatan penting: penilaian ini melihat **kedua** basis, bukan hanya basis
kebijakan. Sebelumnya lokasi yang 5.000% penuh menurut CBM tidak pernah masuk
daftar alert sama sekali bila basis kebijakannya Qty dan Qty-nya masih longgar.

---

## 6. Operasional

- **Cron**: `deploy/crontab.example` (sync → tick → ringkasan harian 08:00 WIB `POST /api/cron/daily-summary`).
- **Google Chat (real-time)**: buat *incoming webhook* di Space (Space → Apps & integrations → Webhooks → Add), lalu buat rute di **Pengaturan → Eskalasi**. Setiap rute memiliki nama, level, cakupan satu/beberapa WH, URL webhook, status aktif, serta daftar user ID untuk auto-tag. Masukkan `all` hanya bila seluruh Space harus ditag. Gunakan **Uji koneksi** sebelum menyimpan. Alert terkirim saat breach zona tercipta dan tiap eskalasi; alert yang sama tergabung satu thread (`threadKey = dedup_key`). Set `APP_BASE_URL` agar kartu membuka detail alert. Referensi format mention: `<users/USER_ID>` pada [dokumentasi Google Chat](https://developers.google.com/workspace/chat/format-messages).
- **Penyimpanan konfigurasi (tahan deploy ulang)**: setiap perubahan dari halaman
  Pengaturan — akun/signup, ambang, kapasitas, gudang, eskalasi, dan Superset
  Sync beserta kredensialnya — ditulis ke `db/runtime-config/` pada volume
  `/app/db`. Aturannya:
  - **Baca**: salinan runtime bila ada; saat upgrade pertama, konfigurasi legacy
    di `config/` menang atas default immutable di `default-config/`.
  - **Tulis**: selalu ke `db/runtime-config/`.
  - **Start pertama**: konfigurasi yang sedang berlaku disalin sekali ke folder
    runtime, termasuk sidecar secret Superset, sehingga penyetelan instalasi
    lama ikut terselamatkan.
  - **Redeploy berikutnya**: file runtime yang sudah ada tidak pernah ditimpa
    seed image. Runtime selalu memiliki precedence tertinggi.
  - **Kembali ke bawaan**: hapus berkas terkait dari `db/runtime-config/`.
  - Lokasi runtime otomatis mengikuti folder `DUCKDB_STATE_PATH`; override khusus
    tetap tersedia melalui `WIOM_RUNTIME_CONFIG_DIR`.
  - Worker Python memakai urutan pencarian yang sama, jadi daemon dan aplikasi web
    selalu membaca `superset-sync.json` yang sama.
  - Verifikasi: halaman **Pengaturan** menampilkan peringatan bila storage tidak
    dapat ditulis, sedangkan `GET /api/health` dan `GET /api/ready` melaporkan
    `config_storage`. `/api/ready` mengembalikan 503 bila folder itu tidak dapat
    ditulis — sehingga deployment yang tidak dapat menyimpan setelan gagal lebih
    awal, bukan diam-diam.
  - **Backup**: backup seluruh volume `/app/db`, bukan hanya berkas `.duckdb`;
    persistent storage melindungi dari pergantian container, tetapi bukan dari
    penghapusan volume, disk rusak, atau kesalahan operator.
- **Penerima lain**: kolom *Webhook Lain* per level menerima URL apa pun yang mau di-POST JSON alert (n8n, Apps Script, sistem tiket).
- **Email**: `SMTP_*` di `.env` (kosong = dilewati).
- **Docker**: `docker compose up -d --build` = dua service: web Node-only + managed sync. Scheduler tick/summary sudah menyatu di supervisor web, jadi tidak memerlukan container ketiga.
- **Integrasi keluar**: `GET /api/alerts|forecast|integrity|sloc?code=`, monitoring `GET /api/health`.

### Profil VPS hemat

- Seluruh stack aplikasi gratis dan open source: Next.js, React, DuckDB, Python,
  pandas, Chart.js, serta Docker Engine/Compose pada VPS Linux.
- Baseline yang masuk akal untuk Compose adalah **2 vCPU / 2 GB RAM**. Limit
  service disetel ke web `0,75 CPU / 384 MB` dan sync `1 CPU / 640 MB`; host
  tetap membutuhkan ruang untuk kernel dan Docker.
- Sync stok berjalan tiap 10 menit. Unduhan Superset disimpan sementara lebih
  dulu; koneksi tulis DuckDB baru dibuka setelah seluruh batch siap, sehingga
  dashboard tidak terkunci selama waktu tunggu jaringan.
- DuckDB sync dibatasi 2 thread/384 MB, pembaca web 2 thread/320 MB. Cache query
  server 5 menit dan refresh browser 10 menit; tab latar belakang tidak refresh.
- Retensi snapshot: detail 6 jam, per jam sampai 3 hari, lalu satu snapshot per
  hari; histori detail maksimum 30 hari. Master ditarik maksimum tiap 12 jam.
- Setelah retensi besar atau penghapusan indeks, kembalikan ruang disk dengan:

```bash
python3 scripts/superset_to_duckdb.py --config config/superset-sync.json --compact
```

Jalankan saat web/sync berhenti. Proses memakai lock eksklusif dan membutuhkan
ruang sementara kira-kira sebesar database aktif sebelum pertukaran atomik.

---

## 7. Keamanan (sebelum dipakai tim)

1. Ganti dua password bootstrap: `npm run hash-password -- "Baru#"` → `config/users.json`.
2. Buat secret sesi dengan `npm run secret:generate`, lalu simpan hasilnya sebagai
   environment variable `SESSION_SECRET` pada server/hosting. `AUTH_SECRET` dan
   `NEXTAUTH_SECRET` juga diterima sebagai alias. Jangan memakai awalan
   `NEXT_PUBLIC_` karena nilainya tidak boleh masuk ke browser.
3. Buat `CRON_SECRET` acak panjang (`openssl rand -hex 32`).
4. Di balik HTTPS set `COOKIE_SECURE=1`.
5. Jangan commit `db/*.duckdb`, `.env`, atau `config/.superset-sync.secrets.json`
   (semuanya sudah di `.gitignore`).
6. **Bila repo ini pernah dipakai sebelum Agustus 2026:** `config/.superset-sync.secrets.json`
   sempat ter-commit (commit `3c64e0a`) berisi cookie sesi Superset yang aktif, dan
   `config/users.json` pernah berisi hash dari tiga password default yang tercetak di bagian 1.
   Perlakukan keduanya sebagai bocor: cabut sesi Superset tersebut, ganti password bootstrap
   aplikasi, lalu pertimbangkan membersihkan riwayat Git. File secrets kini sudah
   di-`.gitignore` dan tidak lagi ter-track.

### Deployment dan login produksi

File `.env` sengaja tidak masuk Git/Docker image. Karena itu secret lokal tidak
otomatis tersedia di deployment. Sebelum deploy atau redeploy:

```bash
npm run secret:generate
```

Salin satu baris keluarannya ke menu **Environment Variables / Secrets** milik
platform hosting:

```text
SESSION_SECRET=<hasil-perintah-di-atas>
COOKIE_SECURE=1
APP_BASE_URL=https://alamat-aplikasi
WIOM_EMBEDDED_SYNC=1
WIOM_SYNC_REQUIRED=1
WIOM_API_SYNC_BOOTSTRAP=1
```

Aktifkan nilai tersebut untuk environment produksi dan lakukan redeploy penuh.
Untuk Docker Compose, letakkan secret yang sama di `.env`; Compose otomatis
memakai service `sync` terpisah, menunggu heartbeat sehat, lalu memulai web.

Sebagai fallback aman untuk deployment **single-instance**, `npm start` akan
membuat secret acak 64 karakter dan menyimpannya sebagai
`db/.wiom-session-secret` bila tidak ada environment secret. File ini berada di
volume `db`, tidak masuk Git, dan dipakai kembali setelah restart. Pada filesystem
read-only aplikasi memakai secret acak sementara sehingga sesi akan berakhir
ketika proses restart. Untuk multi-instance, `SESSION_SECRET` eksplisit tetap
wajib agar semua instance memakai key yang sama.

Verifikasi setelah deploy:

- `GET /api/ready` harus HTTP 200 dengan `status = "ready"`.
- `GET /api/health` harus menampilkan
  `checks.authentication.status = "ok"` tanpa membocorkan nilai secret.
- Log startup harus memuat `Worker Superset siap; web server dapat menerima trafik.`

---

## 8. Catatan teknis

- **Build wajib webpack** (`next build --webpack`, sudah diset) — Turbopack build gagal mem-parsing binary `duckdb`. `npm run dev` tetap Turbopack.
- Kolom `"at"` di state DB di-quote (reserved DuckDB).
- Kapasitas per WH di demo = angka master asli (PGS/STR 200/100, BIT 40/1, BGO 20/2, CBN 100/2, CBT/STL 1/1, SRG 200/1).
- Halaman kosong/error "database belum tersedia" → `npm run seed` (demo) atau nyalakan sync (live).

---

## 12. Analisis backend data — kenapa Superset/ClickHouse → DuckDB (tanpa Google Sheets)

Kebutuhan: super cepat · near-realtime · muat data besar · efisien · 100% gratis · tanpa Sheets · tetap 2 struktur dataset yang sama.

| Opsi penampung/sumber | Kecepatan | Realtime | Data besar | Gratis | Verdict |
|---|---|---|---|---|---|
| Google Sheets sebagai backend | lambat (API + limit 10 jt sel) | tidak (kuota) | ❌ | ✔ | **Ditolak** — bottleneck & rapuh |
| **Superset Chart Data API (dataset) → DuckDB** *(DEFAULT baru)* | baik | loop 600 dtk | ✔ (keyset/offset server-side) | ✔ | **Dipakai** — TANPA SQL Lab, cukup cookie viewer yang bisa buka dashboard (pola Auto Sync v5.5) |
| Superset SQL Lab → DuckDB | baik | loop 600 dtk | ✔ (keyset paging) | ✔ | Cadangan — butuh permission SQL Lab (saat ini tidak tersedia) |
| ClickHouse HTTP langsung → DuckDB | terbaik | loop 60 dtk near-realtime | ✔✔ | ✔ | Cadangan — butuh user read-only ClickHouse (saat ini tidak tersedia) |
| Web query ClickHouse langsung tiap request | cepat | ya | ✔ | ✔ | Ditunda — dashboard jadi tergantung uptime & beban DB produksi; read model tetap best practice |

Keputusan: **DuckDB tetap read model** (embedded, gratis, OLAP kolumnar) dan sumber default kini **`superset_dataset`** — Chart Data API yang sama dengan Auto Sync v5.5: hanya butuh cookie session akun yang bisa MELIHAT dashboard. Tidak perlu SQL Lab, tidak perlu kredensial database.

```jsonc
"source": { "type": "superset_dataset" },   // default — tanpa SQL Lab
"superset": {
  "base_url": "https://superset.astro.internal",
  "force_refresh": true,                     // bypass cache (pelajaran v5.5)
  "auth": { "mode": "cookie", "cookies": { "session": "ISI_COOKIE" } }
}
```

**Galat `{"msg":"Missing Authorization Header"}`** — API Superset instance ini memakai flask-jwt: `/api/v1/*` menuntut header `Authorization: Bearer`, sesi cookie tidak diterima. Solusi #1 (dianjurkan): `auth.mode: "login"` + username & password Superset (`provider` `db`, bila gagal `ldap`) — script menukar kredensial menjadi Bearer dan **login-ulang otomatis** saat token kedaluwarsa di tengah loop. Solusi #2 (bila login web via Google/SSO tanpa password Superset): `auth.mode: "cookie"` + `auth.cookie_header` diisi **seluruh** nilai header `Cookie` dari DevTools → Network → klik request `api/v1` mana pun → Request Headers (jangan hanya `session` — sertakan cookie proxy seperti `CF_Authorization`). `--doctor` kini juga mengetes sesi web (`GET /`) untuk membedakan "cookie hidup tapi API minta Bearer" vs "cookie mati".

**Galat login `{"message":"Not authorized"}`** — kredensial ditolak provider `db`: khas instance yang login web-nya via **Google SSO** (Superset tidak menyimpan password Google). Jangan paksa mode login; `auth.mode: "auto"` (default baru) memakai cookie bila tersedia dan tidak lagi menghentikan run saat login gagal (provider `db` gagal → otomatis dicoba `ldap` sekali). Jalur data kini bertingkat otomatis: **(1)** API v1 `chart/data` (Bearer/sesi) → **(2)** `GET` chart tersimpan bila `chart_id` diisi → **(3)** **legacy `explore_json`** via GET + session cookie (bebas CSRF — jalur klasik integrasi cookie era Auto Sync v5.5; keyset untuk master, sekali-tarik `legacy_row_limit` 200k untuk stok). `--doctor` kini juga **mendekode cookie `session`** tanpa secret: menampilkan usia, utuh/korup-terpotong saat disalin (penyebab tersembunyi "Missing Authorization Header" meski cookie baru), dan ada-tidaknya `_user_id` (cookie anonim = disalin sebelum login), lalu mem-probe jalur legacy per dataset.

**Apakah sync mengikuti filter chart?** Secara desain mode dataset menembak *dataset* langsung, jadi tanpa apa-apa ia menarik **seluruh dataset** (filter yang menempel di SQL virtual dataset selalu ikut). Agar hasil sama dengan irisan chart: **isi `dataset.chart_id`** — filter TERSIMPAN chart (adhoc SIMPLE, custom SQL WHERE, time range/TEMPORAL_RANGE) otomatis **diwarisi** di semua jalur (POST v1 via `filters`+`extras.where`+`time_range`, legacy via `adhoc_filters`+`time_range`), sementara kolom/metrik aplikasi tetap stabil; `--doctor` menampilkan filter warisan yang terbaca. Dua batasan jujur: filter dari **filter bar dashboard (native filter) tidak tersimpan di chart** — pindahkan ke chart (panel Data → Filters) lalu Save, atau tulis manual di `dataset.filters`; dan jalur fallback `GET chart` memakai query chart sepenuhnya (kolom = kolom chart), jadi pastikan chart fallback memuat semua kolom yang aplikasi butuhkan.

**Melampaui Row Limit 120.000 (SQL_MAX_ROW)** — 120 rb adalah cap *server* per request: tidak ada satu request pun yang bisa melewatinya, dan itu berlaku untuk semua klien. Namun **total baris kini tak terbatas**: jalur POST v1 mem-paging keyset/offset dengan tiap halaman ≤ cap (offset kini memakai *orderby total-order* — seluruh dimensi — agar tidak ada baris terlewat/dobel antar halaman, dan `chunk_size` job boleh dinaikkan sampai cap untuk mengurangi jumlah halaman); jalur legacy agregasi, yang tidak punya offset, otomatis **disegmentasi** per nilai `segment_by` (default `location_id` — nilainya diambil gratis dari filter `IN` warisan chart, atau di-discover lewat query kecil), dan bila satu segmen masih menyentuh cap, dipecah lagi ke kolom berikutnya (mis. `product_detail_status_name`). Satu-satunya jalur yang tetap terpotong di cap adalah fallback terakhir **GET chart** (tanpa parameter paging) — log akan memberi tahu bila itu terjadi; selama POST atau legacy hidup, totalnya tak terbatas. `server_row_cap` bisa disetel di config bila instance berubah.

**Temuan skema produksi (dari introspeksi)** — dataset stok (273) *tidak memiliki* `sku_cbm`/`occupied_cbm`; keduanya kini **diturunkan otomatis**: `sku_cbm = length × width × height ÷ dims_to_cbm_divisor` (default 1.000.000, cm³→m³ — ubah di config bila dimensi bukan cm) lalu `occupied_cbm = stock_qty × sku_cbm`. Dataset master (344) ber-grain **rack×product** (planogram — ada `product_id`, itulah sebabnya chart-nya ±120 rb baris); `vw_sloc` di DuckDB otomatis men-dedupe ke satu baris per rak (prioritas `active=true`, lalu id terkecil), jadi angka SLOC di dashboard tetap benar. `--doctor` kini mem-probe dengan kolom yang sudah dipangkas (mencerminkan sync sungguhan), memangkas URL panjang dari pesan error agar body server terlihat, dan **memperingatkan bila jumlah baris GET chart mencapai Row Limit chart** (mis. tepat 120.000 = kemungkinan terpotong → naikkan Row Limit chart lalu Save).

**Galat `Columns missing in dataset: [...]`** — kabar baik: ini berarti **auth sudah tembus** (request sampai ke validasi query Superset); yang salah tinggal nama kolom. Sync kini **anti tebak-tebakan**: sebelum menarik data ia meng-introspeksi skema asli via `GET /api/v1/dataset/{id}`, meminta hanya kolom yang benar-benar ada, menyaring `orderby`, dan memvalidasi kolom metric & key dengan pesan yang menyebut daftar kolom tersedia; bila endpoint metadata dibatasi, ia memangkas berdasarkan pesan error server lalu mencoba ulang sekali. Kolom yang hilang tidak mematikan aplikasi: `rack_zone/aisle/bay/level/bin` **diturunkan dari `sloc_code`** (format `PGS-ABB1-01-02-L1-01`), `occupied_cbm` dihitung `stock_qty × sku_cbm` bila kosong, sisanya NULL. Untuk merapikan mapping secara permanen jalankan `--columns` — mencetak skema asli tiap dataset dengan tanda kolom mana yang sudah dipakai config.

**Galat `Another sync holds the lock`** — sisa lock dari run yang mati tidak wajar (crash / terminal ditutup), atau memang ada `--loop` lain yang masih berjalan. Lock kini **self-healing**: menyimpan `pid|timestamp`, memeriksa apakah pemegangnya masih hidup (Windows via OpenProcess, POSIX via kill-0), dan **mengambil alih otomatis** bila pemegangnya mati atau lock tak terverifikasi berumur > 1 jam; pemegang yang masih hidup tetap dihormati. Untuk kontrol manual ada `--unlock` — menghapus lock hanya bila pemegangnya terbukti mati (menolak bila masih hidup, lengkap dengan pid-nya untuk di-`taskkill`).

**Galat `warehouse_history.duckdb ... used by another process`** — jangan hapus database. Worker kini mengunduh data tanpa membuka DuckDB, lalu membuat penanda tulis singkat agar pembaca web berhenti membuka koneksi baru. Reader aktif diberi waktu selesai dan worker mencoba kembali sampai 45 detik. Endpoint status tidak lagi membaca DuckDB selama state `queued`/`running`, sehingga halaman Superset Sync aman dibiarkan terbuka saat proses berjalan.

**Galat `app_state.duckdb ... used by another process`** — ada dua instance FIT Occupancy Alert and Monitoring yang memakai state database sama. Startup sekarang menolak instance kedua dan menyebut PID/port pemiliknya. Gunakan satu instance produksi; untuk preview pakai `scripts/start-preview.ps1`, yang otomatis memberi `DUCKDB_STATE_PATH` terpisah dan menonaktifkan worker kedua. Lock startup dan daemon memeriksa identitas waktu mulai proses, sehingga PID Windows yang didaur ulang tidak dianggap sebagai pemilik lama.

Pada sync terjadwal, master SLOC yang masih segar ditandai **TERKINI** dan tidak diunduh ulang untuk menghemat Superset/VPS. Tombol **Sync sekarang** selalu memaksa dua sumber wajib—Master Lokasi dan Snapshot Stok—sehingga keduanya harus berstatus **OK** pada hasil manual.

**Bila sync error** — mulai dari **Pengaturan → Superset Sync → Uji koneksi**. Untuk diagnosis CLI yang lebih rinci jalankan `python3 scripts/superset_to_duckdb.py --config config/superset-sync.json --doctor`: ia mengetes `/health` (jaringan/gateway), `/api/v1/me/` (validitas cookie — penyebab #1 error 401; ambil ulang nilai cookie `session` dari DevTools → Application → Cookies), token CSRF, lalu probe 1 baris tiap dataset dan menunjukkan kolom yang tidak cocok. Galat `502/524` = gateway Cloudflare (origin lambat / bot-filter) — klien kini memakai User-Agent browser, auto-retry dengan backoff, dan timeout 90 dtk. Bila POST `chart/data` tetap ditolak (401/403/CSRF), isi `dataset.chart_id` → sync otomatis fallback ke **GET data chart tersimpan** (bebas CSRF): buat chart *Table · Raw Records* berisi semua kolom raw (untuk stok: + metric `SUM(stock)` berlabel persis `stock_qty`), **Row Limit ≥ 200000**, dan ambil id dari URL `/explore/?slice_id=ANGKA`.

Tiap job membawa blok `dataset`: `id` (angka `datasource_id` di URL explore), `columns` (pemetaan nama kolom dataset → nama tabel), `page` `keyset`/`offset`, opsional `metrics` (mis. `SUM(stock) → stock_qty`, di-groupby server-side — identik dengan struktur dataset stok) dan `filters` statis. Watermark incremental otomatis jadi filter `kolom > nilai`. Managed daemon membaca ulang konfigurasi dan memeriksa permintaan manual tanpa restart; refresh halaman berjalan lebih jarang dan berhenti saat tab browser berada di latar belakang.


---

## 13. Perubahan v4 — akurasi lokasi, basis Bin, dwibahasa

**Akar masalah okupansi (poin 1–7).** Read model menjadikan `config/warehouses.json` sebagai *allowlist*: setiap query bergabung ke `wh_map` (peta `location_id` → kode WH), sehingga hanya 8 gudang yang tampil dan kode gudang tidak lagi ditebak dari awalan `sloc_code`. Total warehouse/Bin memakai seluruh `active=true` pada allowlist agar sama dengan filter Superset. Sementara Zona dan Heatmap hanya memakai subset SLOC aktif yang memiliki kode zona; SLOC aktif yang belum berzona dilaporkan sebagai pengecualian kualitas data di Ringkasan, bukan dibuat menjadi baris “zona kosong”. Indeks heatmap sekarang dihasilkan per-zona di DuckDB, lalu cell dimuat bertahap 600 per permintaan.

**Basis Bin (poin 11).** Basis tampilan kini Kebijakan · Qty · CBM · **Bin**. Bin = lokasi terisi ÷ lokasi aktif, tersedia di KPI jaringan, tabel gudang, tabel zona, detail gudang, detail zona, heatmap (warna sel terisi/kosong), dan Proyeksi (kolom laju Bin). Status visual mengikuti basis yang dipilih; alert selalu memakai basis kebijakan.

**Kepadatan menggantikan Pelanggaran (poin 8).** Menu baru `/density`: filter gudang + ambang (70/80/90/100%), KPI di-atas-100% dan 90–99%, tabel lokasi terpadat yang **bisa diklik** → panel isi lokasi dengan No SKU, nama, kategori, qty, CBM, status. `/breaches` diarahkan ke sini.

**Alert (poin 9).** Papan alert dengan chip filter per gudang, pop-up detail berisi sebab & tindakan berbahasa manusia per rule (R01–R12, ID/EN), tingkat eskalasi, jumlah kejadian, riwayat, dan tombol aksi.

**Dwibahasa (poin 14).** Bahasa Indonesia & English (UK) lewat pemilih ID/EN di topbar; kamus di `lib/i18n-dict.ts`, helper server `lib/i18n.ts`, hook klien `lib/i18n-client.ts`.

**Eskalasi fleksibel (poin 15).** Level dapat ditambah, dihapus, dan diurutkan ulang. Setiap level menerima banyak rute Google Chat yang dibatasi per WH dan memiliki auto-tag sendiri; rute tumpang-tindih ke URL yang sama digabung agar tidak menghasilkan pesan ganda. Email/webhook lain tetap tersedia sebagai kanal opsional. Karena trigger aktif hanya breach zona, level awal memakai pemetaan severity `CRITICAL`.

**Forecast yang jujur.** Horizon dan What-if baru aktif setelah sedikitnya empat snapshot yang terbentang 15 menit. Saat data belum cukup, UI menunjukkan *Awaiting history* dan tidak menampilkan proyeksi nol yang menyesatkan.
