"use client";
// Aksi lifecycle alert: tangani, selesaikan, tandai bukan masalah.
//
// KENAPA BUKAN window.prompt LAGI
// -------------------------------
// Versi sebelumnya meminta catatan lewat `window.prompt` dan melaporkan
// kegagalan lewat `window.alert`. Tiga hal rusak sekaligus karenanya:
//
//  1. Teksnya tidak dapat diterjemahkan. Seluruh aplikasi dwibahasa, tetapi
//     dialog bawaan peramban selalu menampilkan kalimat Indonesia yang ditulis
//     langsung di kode — termasuk untuk pengguna yang memilih English.
//  2. Dialognya lahir DI ATAS panel detail alert yang sudah `aria-modal` dan
//     sudah punya jebakan fokus. Dua lapis modal, satu di antaranya tidak dapat
//     ditata, tidak dapat dibatalkan dengan Escape ke tempat yang benar, dan
//     pada beberapa peramban dapat diblokir sepenuhnya oleh pengaturan situs —
//     yang berarti alert tidak dapat diselesaikan sama sekali.
//  3. `window.prompt` memblokir seluruh utas. Catatan penyelesaian ditulis
//     sambil membaca detail alert di belakangnya; dialog modal peramban justru
//     menutupinya.
//
// Formulir catatan kini tinggal di dalam panel yang sama: dapat dibaca bersama
// angka yang memicu alert, mengikuti bahasa yang dipilih, dan tetap berada di
// dalam jebakan fokus yang sudah dipasang panel induknya.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n-client";

type Action = "ack" | "resolve" | "false-positive";

export default function AlertActions({
  alertId, status, canWrite,
}: { alertId: string; status: string; canWrite: boolean }) {
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState<Action | null>(null);
  /** Aksi yang sedang menunggu catatan; null berarti tidak ada formulir terbuka. */
  const [pending, setPending] = useState<Exclude<Action, "ack"> | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(action: Action, body: string) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/alerts/${alertId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: body }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t("alert.actionFailed"));
      }
      setPending(null);
      setNote("");
      router.refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function start(action: Exclude<Action, "ack">) {
    setError(null);
    setNote("");
    // Membuka formulir yang sama dua kali berarti membatalkannya — tombolnya
    // berperilaku seperti sakelar, sesuai dengan tampilannya saat aktif.
    setPending((current) => (current === action ? null : action));
  }

  function submitNote() {
    if (!pending) return;
    const trimmed = note.trim();
    // Catatan wajib hanya untuk "bukan masalah": itulah satu-satunya aksi yang
    // menyatakan aturannya salah, dan alasannya harus tercatat agar aturan itu
    // dapat diperbaiki. Penyelesaian biasa boleh tanpa catatan.
    if (pending === "false-positive" && !trimmed) {
      setError(t("alert.note.required"));
      return;
    }
    void send(pending, trimmed);
  }

  if (!canWrite) return null;
  const open = status === "NEW" || status === "NOTIFIED";
  const acked = status === "ACKNOWLEDGED";
  if (!open && !acked) return null;

  const working = busy !== null;

  return (
    <div className="alert-actions">
      {pending && (
        <div className="alert-note">
          <label className="block space-y-1">
            <span className="eyebrow">
              {pending === "resolve" ? t("alert.note.resolveTitle") : t("alert.note.fpTitle")}
            </span>
            <textarea
              className="input alert-note-input"
              value={note}
              rows={2}
              autoFocus
              placeholder={t("alert.note.placeholder")}
              onChange={(event) => { setNote(event.target.value); setError(null); }}
              onKeyDown={(event) => {
                // Enter mengirim, Shift+Enter menyisipkan baris baru. Escape
                // hanya menutup formulir catatan — panel alert di belakangnya
                // tetap terbuka, karena membatalkan catatan bukan berarti
                // selesai membaca alertnya.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitNote();
                } else if (event.key === "Escape") {
                  event.stopPropagation();
                  setPending(null);
                  setError(null);
                }
              }}
            />
          </label>
          <p className="alert-note-hint">
            {pending === "resolve" ? t("alert.note.resolveHint") : t("alert.note.fpHint")}
          </p>
          <div className="alert-note-actions">
            <button type="button" className="btn btn-sm" disabled={working}
              onClick={() => { setPending(null); setError(null); }}>
              {t("alert.note.cancel")}
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={working}
              onClick={submitNote}>
              {working ? t("alert.working") : t("alert.note.submit")}
            </button>
          </div>
        </div>
      )}

      {error && <p className="alert-note-error" role="alert">{error}</p>}

      <div className="alert-actions-row">
        {open && (
          <button className="btn btn-sm" disabled={working}
            onClick={() => { setPending(null); void send("ack", ""); }}>
            {busy === "ack" ? t("alert.working") : t("alert.ackBtn")}
          </button>
        )}
        <button className="btn btn-sm btn-primary" disabled={working}
          aria-expanded={pending === "resolve"}
          onClick={() => start("resolve")}>
          {t("alert.resolveBtn")}
        </button>
        <button className="btn btn-sm btn-danger" disabled={working}
          aria-expanded={pending === "false-positive"}
          onClick={() => start("false-positive")}>
          {t("alert.fpBtn")}
        </button>
      </div>
    </div>
  );
}
