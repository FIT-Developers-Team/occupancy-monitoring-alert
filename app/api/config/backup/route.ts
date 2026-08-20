// Unduh dan pulihkan seluruh konfigurasi yang dapat diubah admin.
//
// Ini adalah jalan keluar dari satu keharusan yang tidak dimiliki semua
// operator: memindahkan konfigurasi dari container lama ke volume permanen
// sebelumnya menuntut `docker cp` dari terminal server. Dengan endpoint ini,
// panel Coolify saja sudah cukup — unduh sebelum memasang volume, pulihkan
// sesudahnya.
//
// Isi cadangan mencakup berkas yang memuat kredensial (webhook Google Chat,
// cookie Superset, hash kata sandi akun). Karena itu:
//   - hanya admin yang boleh memanggilnya,
//   - jawabannya tidak pernah disimpan cache,
//   - setiap pengunduhan dan pemulihan tercatat di Audit Trail.
// Seluruh nilai tersebut memang sudah berada dalam kuasa admin yang sama lewat
// halaman Pengaturan; yang ditambahkan di sini hanyalah cara memindahkannya.
import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { invalidateOccupancyReadCaches } from "@/lib/queries";
import {
  CONFIG_BUNDLE_ENV,
  encodeConfigBundle,
  exportConfigBundle,
  importConfigBundle,
} from "@/lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate" };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) return null;
  return user;
}

export async function GET(request: NextRequest) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });

  const bundle = exportConfigBundle();
  const names = Object.keys(bundle.files);
  await audit(user.username, "CONFIG_BACKUP_EXPORT", "config:backup", undefined, { files: names });

  // Bentuk "env" sengaja teks polos satu baris: itulah yang ditempel ke
  // Environment Variables Coolify, dan kutip atau baris baru di sana justru
  // membuat nilainya rusak diam-diam.
  if (request.nextUrl.searchParams.get("format") === "env") {
    return new NextResponse(encodeConfigBundle(bundle), {
      status: 200,
      headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" },
    });
  }

  const stamp = bundle.created_at.slice(0, 19).replace(/[:T]/g, "");
  return new NextResponse(`${JSON.stringify(bundle, null, 2)}\n`, {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="wiom-config-${stamp}.json"`,
    },
  });
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });

  // Berkas unduhan dikirim apa adanya sebagai JSON; nilai environment yang
  // disalin dari kolom "salin" datang sebagai base64 di dalam { bundle }.
  const body = await request.text();
  let payload: unknown;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    payload = typeof parsed?.bundle === "string" ? parsed.bundle : parsed;
  } catch {
    payload = body;
  }

  try {
    const restored = importConfigBundle(payload);
    invalidateOccupancyReadCaches();
    await audit(user.username, "CONFIG_BACKUP_RESTORE", "config:backup", undefined, { files: restored });
    return NextResponse.json({ restored, env_name: CONFIG_BUNDLE_ENV }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: `Pemulihan gagal: ${(error as Error).message}` },
      { status: 400, headers: NO_STORE },
    );
  }
}
