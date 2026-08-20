// Liveness — satu-satunya endpoint yang boleh dipakai healthcheck container.
//
// KENAPA TERPISAH DARI /api/ready
// -------------------------------
// Healthcheck image sebelumnya menunjuk ke `/api/ready`, dan `/api/ready`
// menjawab pertanyaan yang jauh lebih luas: apakah akun admin sudah ada,
// apakah konfigurasi berada di volume permanen, apakah worker Superset siap.
// Semua itu penting, tetapi tidak satu pun dari semuanya berarti "server web
// ini rusak".
//
// Akibatnya nyata dan mahal: pada deploy 2026-08-20 container menyalakan
// Next.js dengan sempurna ("Ready", listen di 0.0.0.0:3000), tetapi karena
// volume permanen belum terpasang `/api/ready` menjawab 503. Docker menandai
// container tidak sehat, Coolify menggulung balik ke container lama, dan
// deployment itu mustahil berhasil — sementara satu-satunya cara memperbaiki
// keadaannya (membuka halaman Pengaturan) ada di dalam container yang barusan
// dibuang.
//
// Karena itu pemisahannya tegas:
//   /api/live   — proses hidup dan dapat melayani HTTP. Dipakai orkestrator.
//   /api/ready  — kesiapan operasional lengkap. Dipakai manusia dan monitoring.
//   /api/health — kesehatan data (kesegaran snapshot). Dipakai monitoring.
//
// Handler ini sengaja tidak menyentuh DuckDB, konfigurasi, maupun filesystem:
// apa pun yang dapat gagal di luar server web tidak boleh dapat menjatuhkan
// container yang sebenarnya sehat.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "live",
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
