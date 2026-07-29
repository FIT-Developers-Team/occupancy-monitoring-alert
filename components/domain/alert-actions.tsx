"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AlertActions({
  alertId, status, canWrite,
}: { alertId: string; status: string; canWrite: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(action: "ack" | "resolve" | "false-positive") {
    let note = "";
    if (action === "resolve") {
      note = window.prompt("Catatan penyelesaian (opsional):") ?? "";
    } else if (action === "false-positive") {
      const n = window.prompt("Kenapa false positive? Catatan ini masuk loop perbaikan rule:");
      if (n === null) return;
      note = n;
    }
    setBusy(action);
    const res = await fetch(`/api/alerts/${alertId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else {
      const j = await res.json().catch(() => ({}));
      window.alert(j.error || "Aksi gagal dijalankan.");
    }
  }

  if (!canWrite) return null;
  const open = status === "NEW" || status === "NOTIFIED";
  const acked = status === "ACKNOWLEDGED";
  if (!open && !acked) return null;

  return (
    <div className="flex items-center gap-1.5">
      {open && (
        <button className="btn btn-sm" disabled={busy !== null} onClick={() => act("ack")}>
          {busy === "ack" ? "…" : "Ack"}
        </button>
      )}
      <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => act("resolve")}>
        {busy === "resolve" ? "…" : "Selesai"}
      </button>
      <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => act("false-positive")}>
        {busy === "false-positive" ? "…" : "FP"}
      </button>
    </div>
  );
}
