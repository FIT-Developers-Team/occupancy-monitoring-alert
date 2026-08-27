"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n-client";

export default function RunTickButton({ enabled = true }: { enabled?: boolean }) {
  const router = useRouter();
  const { lang } = useT();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function run() {
    setBusy(true);
    setFailed(false);
    // `fetch` yang menolak — jaringan putus, proxy memutus koneksi, tab
    // kehilangan sambungan — melempar sebelum baris `setBusy(false)` tercapai.
    // Tanpa penjagaan ini tombolnya tinggal selamanya pada "Mengevaluasi…"
    // dalam keadaan nonaktif, dan satu-satunya jalan keluarnya memuat ulang
    // halaman. Kegagalan jaringan justru saat yang paling butuh tombol ini
    // dapat ditekan lagi.
    let response: Response;
    try {
      response = await fetch("/api/cron/tick", { method: "POST" });
    } catch (error) {
      setBusy(false);
      setFailed(true);
      setLast(lang === "en"
        ? `Evaluation could not be sent — ${(error as Error).message}`
        : `Evaluasi tidak terkirim — ${(error as Error).message}`);
      return;
    }
    const body = await response.json().catch(() => null);
    setBusy(false);
    if (response.ok && body) {
      const delivery = body.notification_failed
        ? lang === "en" ? ` · ${body.notification_failed} delivery failed` : ` · ${body.notification_failed} pengiriman gagal`
        : body.notified
          ? lang === "en" ? ` · ${body.notified} sent` : ` · ${body.notified} terkirim`
          : "";
      setFailed(Boolean(body.notification_failed));
      setLast(lang === "en"
        ? `+${body.created} new · ${body.updated} updated · ${body.auto_resolved} auto-resolved · ${body.escalated} escalated${delivery}`
        : `+${body.created} baru · ${body.updated} diperbarui · ${body.auto_resolved} auto-selesai · ${body.escalated} eskalasi${delivery}`);
      router.refresh();
    } else {
      setFailed(true);
      setLast(body?.error || (lang === "en" ? "Evaluation failed — check system health." : "Evaluasi gagal — periksa kesehatan sistem."));
    }
  }

  if (!enabled) return null;

  return (
    <div className="flex items-center gap-2">
      {last && <span className="eyebrow" role="status" style={failed ? { color: "var(--st-critical-fg)" } : undefined}>{last}</span>}
      <button className="btn btn-sm btn-primary" onClick={run} disabled={busy}>
        {busy ? (lang === "en" ? "Evaluating…" : "Mengevaluasi…") : (lang === "en" ? "Evaluate now" : "Evaluasi sekarang")}
      </button>
    </div>
  );
}
