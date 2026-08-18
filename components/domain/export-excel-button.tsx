"use client";
// Tombol unduh Excel untuk tabel mana pun.
//
// Berkas diambil lewat fetch, bukan <a download>, karena ekspor penuh sebuah
// gudang bisa berjalan beberapa detik: dengan fetch tombol dapat menahan klik
// ganda, menampilkan progres, dan melaporkan kegagalan alih-alih membiarkan tab
// tampak menggantung.
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n-client";

export default function ExportExcelButton({
  dataset,
  params,
  label,
  disabled = false,
  variant = "default",
  title,
}: {
  dataset: string;
  /** Filter yang sedang tampil — persis parameter yang dipakai tabel. */
  params?: URLSearchParams | Record<string, string>;
  label?: string;
  disabled?: boolean;
  variant?: "default" | "primary" | "ghost";
  title?: string;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const download = useCallback(async () => {
    if (busy) return;
    const search = params instanceof URLSearchParams
      ? new URLSearchParams(params)
      : new URLSearchParams(params ?? {});
    search.set("dataset", dataset);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/export?${search}`, { signal: controller.signal });
      if (!response.ok) {
        const message = await response.json().catch(() => null);
        throw new Error(message?.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const filename =
        response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1]
        ?? `${dataset}.xlsx`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoke ditunda satu putaran agar Safari sempat memulai unduhan.
      setTimeout(() => URL.revokeObjectURL(url), 2_000);
    } catch (requestError) {
      if ((requestError as { name?: string })?.name === "AbortError") return;
      if (mountedRef.current) setError((requestError as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, dataset, params]);

  const className =
    variant === "primary" ? "btn btn-primary btn-sm export-btn"
    : variant === "ghost" ? "btn btn-ghost btn-sm export-btn"
    : "btn btn-sm export-btn";

  return (
    <span className="export-btn-wrap">
      <button
        type="button"
        className={className}
        onClick={download}
        disabled={disabled || busy}
        title={title ?? t("export.hint")}
        aria-busy={busy}
      >
        {busy ? (
          <span className="export-spinner" aria-hidden="true" />
        ) : (
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" />
          </svg>
        )}
        <span>{busy ? t("export.working") : label ?? t("export.excel")}</span>
      </button>
      {error && (
        <span className="export-error" role="alert">
          {t("export.failed")} — {error}
        </span>
      )}
    </span>
  );
}
