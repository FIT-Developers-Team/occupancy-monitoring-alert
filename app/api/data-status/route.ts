import { NextResponse } from "next/server";
import { historyDataVersion } from "@/lib/db";
import { getSupersetSyncStatus } from "@/lib/superset-sync";

export const dynamic = "force-dynamic";

/**
 * Kesegaran data untuk indikator topbar.
 *
 * `dataVersion` adalah penanda snapshot DuckDB yang sedang berlaku, dan itulah
 * yang dipakai browser untuk memutuskan kapan halaman perlu dimuat ulang —
 * bukan `updatedAt`. Bedanya penting: `updatedAt` bergerak setiap kali worker
 * menyelesaikan satu pass, termasuk pass yang tidak menulis apa pun, sedangkan
 * `dataVersion` hanya bergerak bila berkasnya benar-benar berubah. Sinyal yang
 * sama pula yang membatalkan read model di server, jadi keduanya tidak dapat
 * berbeda pendapat soal "ada data baru".
 */
export async function GET() {
  const dataVersion = historyDataVersion();
  const hasSnapshot = dataVersion !== "missing";
  try {
    const status = getSupersetSyncStatus();
    return NextResponse.json({
      state: status.state,
      phase: status.phase ?? null,
      updatedAt: status.finished_at ?? status.updated_at ?? null,
      workerOnline: status.worker.online,
      workerReady: status.worker.ready,
      hasSnapshot,
      dataVersion,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      state: "failed",
      workerOnline: false,
      workerReady: false,
      hasSnapshot,
      dataVersion,
      error: (error as Error).message,
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
