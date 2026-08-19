"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Menahan Tab di dalam satu panel modal.
 *
 * Panel detail heatmap, dialog zona, dan panel detail Penjelajah SLOC semuanya
 * memakai `aria-modal`, tetapi atribut itu hanya sebuah janji. Tanpa jebakan
 * fokus, Tab menembus ke tabel dan tombol di belakang panel: pengguna keyboard
 * dapat mengurutkan kolom atau memicu ekspor pada daftar yang sedang tertutup.
 *
 * Pasang pada elemen dialog: `onKeyDown={(event) => { trapFocus(event); … }}`.
 * Dibagikan dalam satu modul agar tiga panel yang tampak serupa tidak
 * berperilaku berbeda hanya karena salinannya menyimpang.
 */
export function trapFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
