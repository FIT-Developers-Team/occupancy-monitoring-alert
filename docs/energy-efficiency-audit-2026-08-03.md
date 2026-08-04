# Audit efisiensi energi dan VPS — 2026-08-03

## Ringkasan hasil

| Area | Sebelum | Sesudah | Dampak |
|---|---:|---:|---:|
| DuckDB history | 1.176,5 MiB | 63,26 MiB | -94,6% |
| Next build (`.next`) | 1.297,36 MiB | 215,40 MiB | -83,4% |
| Runtime standalone | 1.175,77 MiB | 77,25 MiB | -93,4% |
| Snapshot history | 43 | 19 | Retensi bertingkat |
| Indeks DuckDB | 25 | 2 | Hanya indeks master yang terpakai |
| Audit dependency produksi | 10 temuan (9 high, 1 critical) | 0 | Bersih |
| Dashboard cold request | gagal/putus pada limit 256 MB | 200 dalam 2,75 detik | Stabil |
| Working set web | — | puncak 293,4 MiB; selesai 121 MiB | Muat di limit 384 MiB |

Pengurangan disk terukur dari DB, build, virtualenv, spill sementara, dan font
lokal sekurangnya 2,4 GiB. Tidak ada data bisnis yang dihapus tanpa retensi:
fingerprint setelah kompaksi tetap 1.296.369 baris history, 86.414 baris latest,
5.403.162 unit latest, 214.520 master, dan 99 audit sync.

## Arsitektur akhir

```text
Superset -- tiap 10 menit --> sync Python (1 CPU / 640 MiB)
                                  |
                                  v
                         DuckDB volume 63 MiB
                                  |
                                  v
Browser -- tiap 10 menit --> web Node (0,75 CPU / 384 MiB)
                              cache query 5 menit
```

- Compose memakai dua service. Scheduler alert menyatu dengan supervisor web;
  tidak ada container ketiga.
- Sync mengunduh batch ke JSONL sementara sebelum mengambil lock tulis DuckDB.
  Waktu tunggu jaringan tidak lagi memblokir pembaca dashboard.
- DuckDB dibatasi dua thread. Web memakai limit query 320 MB; sync 384 MB.
- Database menggunakan storage compatibility `v1.3.0` agar Python DuckDB baru
  tetap dapat dibaca binding Node DuckDB 1.3.2.
- Runtime Docker tidak membawa database, secret, status sync, font, Sharp,
  TypeScript, atau tipe build-time.

## Pengurangan kerja berulang

- Refresh browser: 2 menit + render countdown per detik menjadi 10 menit tanpa
  countdown. Tab tersembunyi tidak refresh.
- Tren halaman utama: 7 hari menjadi 48 jam, sesuai horizon keputusan shift.
- Query server di-cache 5 menit dan akses history diserialkan agar dua thread
  DuckDB tidak berebut memori pada VPS kecil.
- Prefetch route berat dimatikan. Chart tren dan What-if dimuat secara lazy.
- Enam font WOFF2 diganti system font stack; tidak ada request font tambahan.
- Halaman utama diringkas menjadi lima KPI inti, tabel gudang, dua panel risiko,
  dan satu tren. Copy penjelas non-operasional dihilangkan.

## Retensi data

- Snapshot detail dipertahankan 6 jam.
- Setelah itu satu snapshot per jam sampai 3 hari.
- Setelah 3 hari satu snapshot per hari, maksimum 30 hari.
- Master SLOC diperbarui maksimum tiap 12 jam.
- `--compact` menulis database baru secara atomik dan mengembalikan ruang kosong.

Retensi ini mengikuti prinsip minimisasi data dan pengurangan operasi berulang
dari [W3C Web Sustainability Guidelines](https://www.w3.org/TR/web-sustainability-guidelines/).
Pola single-writer/short-lived reader mengikuti
[DuckDB concurrency](https://duckdb.org/docs/current/connect/concurrency), dan
kompaksi/storage compatibility mengikuti
[DuckDB storage compatibility](https://duckdb.org/docs/current/internals/storage).

## Profil VPS

Target awal: Linux VPS 2 vCPU / 2 GB RAM dengan Docker Engine/Compose.

| Service | CPU limit | Memory limit | Peran |
|---|---:|---:|---|
| web | 0,75 | 384 MiB | UI, API, scheduler |
| sync | 1,00 | 640 MiB | ekstraksi Superset + writer DuckDB |

Sisa RAM dipakai kernel, page cache, dan engine container. Jangan menurunkan
limit web di bawah 384 MiB: kueri tren cold-start terukur mencapai 293,4 MiB
working set dan DuckDB 256 MB menyebabkan terminasi native.

Semua komponen aplikasi adalah gratis dan open source: Next.js, React, Node.js,
DuckDB, Python, pandas, requests, Chart.js, serta Docker Engine/Compose di Linux.
Tidak ada SaaS berbayar baru.

## Kualitas data yang membatasi interpretasi

- Dari 214.520 master SLOC, 79,5% `max_quantity` kosong/sentinel `<=1` dan
  87,4% `max_volume` kosong/sentinel `<=1`.
- Ada 633 kode SLOC aktif yang duplikat lintas baris.
- Snapshot latest berisi 69.463 Available, 9.683 Lost, dan 7.268 Bad.
- Karena itu okupansi tetap memakai allowlist `location_id`, basis kebijakan,
  dan override kapasitas; angka kapasitas mentah tidak boleh dianggap final.

## File yang dibuang atau dikecualikan

- `.venv` lokal 168,57 MiB; dapat dibuat ulang dari `scripts/requirements.txt`.
- Spill/temp DuckDB lama 110,25 MiB dan heartbeat/lock dengan PID mati.
- Enam font lokal 111 KiB; diganti system fonts.
- `scripts/scheduler.mjs`; fungsinya sudah masuk supervisor produksi.
- Database/secret runtime dikeluarkan dari Next standalone dan Git.

Penghapusan tersebut dapat dipulihkan dari dependency manifest atau Git; data
history aktif tidak dihapus di luar kebijakan retensi yang telah diverifikasi.

## Verifikasi

- `npm run build`: lulus compile, TypeScript, 19 static pages, dan build trace.
- `npm audit --omit=dev`: 0 vulnerability.
- Standalone smoke: login, `/`, `/occupancy`, `/integrity`, `/forecast` = 200.
- `docker compose config --quiet`: lulus.
- Python compile dan `--check-runtime`: lulus; dua job aktif.
- Standalone: 0 database/secret/status runtime ikut terpaket.
- `/api/health` dan `/api/ready` = 503 pada smoke terpisah karena worker sync
  sengaja tidak dijalankan dan snapshot berumur 89 menit. Ini bukan kegagalan
  web; Compose menunggu heartbeat worker sebelum web siap.

## Batas verifikasi

- Docker daemon lokal tidak aktif, sehingga image final belum dapat dibangun;
  konfigurasi Compose dan artefak standalone sudah diverifikasi.
- Browser aplikasi memblokir kontrol lanjutan setelah capture login. Dashboard
  telah diverifikasi secara HTTP/runtime, tetapi audit visual final layar
  terautentikasi belum diklaim selesai.

Referensi implementasi: [Next.js standalone](https://nextjs.org/docs/app/api-reference/config/next-config-js/output),
[Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading), dan
[Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/).
