"use client";
import { toCsv } from "@/lib/utils";

export default function CsvButton({
  rows, filename, label = "Unduh CSV",
}: { rows: Record<string, unknown>[]; filename: string; label?: string }) {
  function download() {
    const blob = new Blob(["\ufeff" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button className="btn btn-sm" onClick={download} disabled={!rows.length}>
      {label}
    </button>
  );
}
