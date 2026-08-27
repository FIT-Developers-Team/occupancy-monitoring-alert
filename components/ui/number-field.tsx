"use client";
// Input angka yang boleh dikosongkan sementara.
//
// MASALAH YANG DIPERBAIKINYA
// --------------------------
// Pola yang tersebar di seluruh layar Pengaturan adalah
// `value={config.x}` + `onChange={(e) => set(Number(e.target.value))}`.
// `Number("")` bernilai 0, jadi begitu pengguna menghapus isi kolom untuk
// mengetik ulang, nilainya melompat ke 0 dan kolomnya langsung menampilkan
// "0". Angka yang diketik berikutnya menempel di belakang nol itu — mengetik
// "30" pada kolom interval menghasilkan "030" — dan kalau pengguna sempat
// menekan Simpan saat kolomnya kosong, yang tersimpan adalah 0, yang lalu
// ditolak skema dengan pesan validasi yang tidak menyebut kolom mana pun.
//
// Menghapus lalu mengetik ulang adalah cara paling wajar mengubah sebuah angka.
// Karena itu komponen ini menyimpan teks yang sedang diketik apa adanya, dan
// baru menyerahkan angkanya ketika teks itu benar-benar sebuah angka. Kolom
// yang kosong tetap kosong selama masih difokus.
//
// Pembatasan min/max dikerjakan saat fokus berpindah, bukan pada setiap
// ketikan: memaksakan batas per huruf membuat "5" berubah menjadi "500" di
// tengah pengetikan pada kolom yang batas bawahnya 500.
import { useState } from "react";

export default function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  inputMode = "numeric",
  className = "input num",
  disabled,
  id,
  name,
  placeholder,
  title,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: {
  value: number;
  /** Dipanggil hanya dengan angka yang sahih — tidak pernah dengan NaN. */
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  /** Papan tombol ponsel: "decimal" untuk nilai pecahan seperti m³ per unit. */
  inputMode?: "numeric" | "decimal";
  className?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  placeholder?: string;
  title?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  /** Teks yang sedang diketik; `null` berarti kolomnya menampilkan `value`. */
  const [draft, setDraft] = useState<string | null>(null);

  const clamp = (candidate: number) => {
    let next = candidate;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };

  return (
    <input
      className={className}
      type="number"
      inputMode={inputMode}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      id={id}
      name={name}
      placeholder={placeholder}
      title={title}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      value={draft ?? String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        // Nilai di luar batas tetap diteruskan selagi diketik; blur yang
        // merapikannya. Menolaknya di sini berarti "9" tidak pernah dapat
        // menjadi "90" pada kolom yang batas bawahnya 10.
        const parsed = Number(raw);
        if (raw.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        const raw = draft;
        setDraft(null);
        if (raw === null) return;
        const parsed = Number(raw);
        // Kolom yang ditinggalkan kosong atau berisi teks yang bukan angka
        // kembali ke nilai terakhir yang sahih, bukan ke nol.
        if (raw.trim() === "" || !Number.isFinite(parsed)) {
          onChange(value);
          return;
        }
        const clamped = clamp(parsed);
        if (clamped !== parsed) onChange(clamped);
      }}
    />
  );
}
