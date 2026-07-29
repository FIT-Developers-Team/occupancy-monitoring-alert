"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RunTickButton({ enabled = true }: { enabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const res = await fetch("/api/cron/tick", { method: "POST" });
    const j = await res.json().catch(() => null);
    setBusy(false);
    if (res.ok && j) {
      setLast(`+${j.created} baru · ${j.updated} update · ${j.auto_resolved} auto-selesai · ${j.escalated} eskalasi`);
      router.refresh();
    } else {
      setLast("Evaluasi gagal — cek /api/health.");
    }
  }

  if (!enabled) return null;

  return (
    <div className="flex items-center gap-2">
      {last && <span className="eyebrow">{last}</span>}
      <button className="btn btn-sm btn-primary" onClick={run} disabled={busy}>
        {busy ? "Mengevaluasi…" : "Evaluasi sekarang"}
      </button>
    </div>
  );
}
