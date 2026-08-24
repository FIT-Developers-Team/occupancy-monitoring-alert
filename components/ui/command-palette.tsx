"use client";
// Command palette v2 — grup: Halaman · Gudang · Aksi · Data (SLOC/produk live).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n-client";
import { trapFocus } from "@/lib/focus-trap";

type ItemGroup = "pages" | "warehouses" | "actions" | "data";

interface Item {
  id: string; group: ItemGroup;
  label: string; hint: string;
  href?: string; action?: () => void | Promise<void>;
}

export default function CommandPalette({
  role,
  warehouses,
}: {
  role: string;
  /** Kode gudang dari konfigurasi, bukan daftar tetap di dalam berkas ini. */
  warehouses: string[];
}) {
  const router = useRouter();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [dataItems, setDataItems] = useState<Item[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Elemen yang membuka palette, supaya fokus dapat dikembalikan ke sana.
   *
   * Palette dapat dibuka dari tombol di topbar maupun dari ⌘K di tengah
   * halaman mana pun. Menutupnya tanpa mengembalikan fokus membuang pengguna
   * keyboard kembali ke `<body>`: Tab berikutnya memulai lagi dari tautan
   * pertama di halaman, jauh dari tempat mereka tadi bekerja.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setDataItems([]);
    setIdx(0);
    const opener = openerRef.current;
    openerRef.current = null;
    // Setelah React melepas dialognya, bukan sebelumnya — kalau tidak, elemen
    // yang menerima fokus masih tertutup panel yang sedang dibongkar.
    requestAnimationFrame(() => opener?.focus());
  }, []);

  const openPalette = useCallback(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setOpen(true);
    setQ("");
    setIdx(0);
  }, []);

  // Sinyal yang sama dengan tombol basis di topbar. Tanpa `wiom:basis`,
  // mengganti basis dari palette hanya merender ulang komponen server:
  // heatmap — yang membaca cookie hanya saat sinyal itu tiba — tetap
  // menggambar basis sebelumnya di halaman yang sedang dibuka.
  const setBasis = useCallback((v: string) => {
    document.cookie = `wiom_basis=${v}; path=/; max-age=31536000; samesite=lax`;
    window.dispatchEvent(new Event("wiom:basis"));
    router.refresh();
  }, [router]);

  const pages = useMemo<Item[]>(() => ([
    { id: "p-exec", group: "pages", label: t("nav.exec"), hint: t("palette.networkKpi"), href: "/" },
    { id: "p-occ", group: "pages", label: t("nav.occupancy"), hint: t("palette.warehouseZones"), href: "/occupancy" },
    { id: "p-heat", group: "pages", label: t("nav.heatmap"), hint: t("palette.locationGrid"), href: "/heatmap" },
    { id: "p-mv", group: "pages", label: t("nav.movements"), hint: t("palette.movements"), href: "/movements" },
    { id: "p-fc", group: "pages", label: t("nav.forecast"), hint: t("palette.forecast"), href: "/forecast" },
    { id: "p-dens", group: "pages", label: t("nav.density"), hint: t("palette.priority"), href: "/density" },
    { id: "p-al", group: "pages", label: t("nav.alerts"), hint: t("palette.alertWork"), href: "/alerts" },
    { id: "p-aud", group: "pages", label: t("nav.audit"), hint: t("palette.auditLog"), href: "/audit" },
    { id: "p-gd", group: "pages", label: t("nav.guide"), hint: t("palette.guide"), href: "/guide" },
    { id: "p-set", group: "pages", label: t("nav.settings"), hint: t("palette.configuration"), href: "/settings" },
  ] satisfies Item[]).filter((item) => role === "admin" || (item.href !== "/audit" && item.href !== "/settings")), [role, t]);

  const actions: Item[] = useMemo(() => [
    { id: "a-tick", group: "actions", label: t("palette.evaluateAlerts"), hint: t("palette.runTick"),
      action: async () => { await fetch("/api/cron/tick", { method: "POST" }); router.push("/alerts"); router.refresh(); } },
    { id: "a-bpol", group: "actions", label: t("palette.viewBasis").replace("{basis}", t("basis.policy")), hint: "default", action: () => setBasis("policy") },
    { id: "a-bqty", group: "actions", label: t("palette.viewBasis").replace("{basis}", t("basis.qty")), hint: t("common.unit"), action: () => setBasis("qty") },
    { id: "a-bcbm", group: "actions", label: t("palette.viewBasis").replace("{basis}", t("basis.cbm")), hint: "m³", action: () => setBasis("cbm") },
    { id: "a-bbin", group: "actions", label: t("palette.viewBasis").replace("{basis}", t("basis.bin")), hint: t("basis.binHint"), action: () => setBasis("bin") },
    { id: "a-theme", group: "actions", label: t("palette.switchTheme"), hint: t("palette.themeHint"),
      action: () => {
        const dark = document.documentElement.classList.toggle("dark");
        try { localStorage.setItem("wiom-theme", dark ? "dark" : "light"); } catch {}
        // Grafik melukis ke canvas dan tidak ikut `var(--…)`; tanpa sinyal ini
        // mereka tetap memakai warna tema sebelumnya sampai halaman dimuat ulang.
        window.dispatchEvent(new Event("wiom:theme"));
      } },
    { id: "a-out", group: "actions", label: t("action.logout"), hint: t("palette.signOutHint"),
      action: async () => { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); } },
  ], [router, setBasis, t]);

  const whItems: Item[] = useMemo(() => warehouses.flatMap((w) => [
    { id: `w-h-${w}`, group: "warehouses" as const, label: `${t("nav.heatmap")} ${w}`, hint: t("palette.heatmapHint"), href: `/heatmap?wh=${w}` },
    { id: `w-o-${w}`, group: "warehouses" as const, label: `${t("nav.occupancy")} ${w}`, hint: t("palette.occupancyHint"), href: `/occupancy/${w}` },
    { id: `w-m-${w}`, group: "warehouses" as const, label: `${t("nav.movements")} ${w}`, hint: t("palette.movements"), href: `/movements?wh=${w}` },
  ]), [t, warehouses]);

  // Pencarian data (SLOC & produk) — debounce 200 ms
  useEffect(() => {
    if (!open) return;
    const s = q.trim();
    if (debRef.current) clearTimeout(debRef.current);
    if (s.length < 2) { setDataItems([]); return; }
    debRef.current = setTimeout(async () => {
      try {
        const j = await fetch(`/api/search?q=${encodeURIComponent(s)}`).then((r) => r.json());
        const items: Item[] = [
          ...(j.slocs ?? []).map((x: { sloc_code: string; wh: string; zone: string }) => ({
            id: `d-s-${x.sloc_code}`, group: "data" as const,
            label: x.sloc_code,
            hint: t("palette.slocHint").replace("{scope}", `${x.wh} ${x.zone}`),
            href: `/heatmap?wh=${x.wh}&sloc=${encodeURIComponent(x.sloc_code)}`,
          })),
          ...(j.products ?? []).map((x: {
            product_name: string; sku_number: string; wh: string; zone: string; sloc_code: string;
          }) => ({
            id: `d-p-${x.sku_number}-${x.wh}-${x.sloc_code}`, group: "data" as const,
            label: x.product_name, hint: `SKU ${x.sku_number} · ${x.wh} ${x.zone}`,
            href: `/heatmap?wh=${x.wh}&sloc=${encodeURIComponent(x.sloc_code)}`,
          })),
        ];
        setDataItems(items);
      } catch { setDataItems([]); }
    }, 200);
  }, [q, open, t]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = [...pages, ...whItems, ...actions];
    const filtered = s
      ? base.filter((i) => (i.label + " " + i.hint).toLowerCase().includes(s))
      : base.filter((i) => i.group !== "warehouses" || i.id.startsWith("w-h-"));
    const all = [...filtered.slice(0, 14), ...dataItems];
    return all;
  }, [q, pages, whItems, actions, dataItems]);

  const grouped = useMemo(() => {
    const order: ItemGroup[] = ["pages", "warehouses", "actions", "data"];
    return order
      .map((g) => ({ group: g, items: results.filter((r) => r.group === g) }))
      .filter((g) => g.items.length);
  }, [results]);

  const groupLabel: Record<ItemGroup, string> = {
    pages: t("palette.pages"),
    warehouses: t("palette.warehouses"),
    actions: t("palette.actions"),
    data: t("palette.data"),
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close(); else openPalette();
      } else if (e.key === "Escape" && open) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, openPalette]);

  /**
   * Sorotan hasil harus selalu terlihat.
   *
   * Daftarnya bergulir di dalam kotak setinggi 52vh, sementara panah bawah
   * hanya memindahkan indeks. Tanpa ini, menekan panah beberapa kali
   * memindahkan pilihan ke baris yang sudah berada di luar layar: Enter
   * membuka sesuatu yang tidak sedang dilihat siapa pun.
   */
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [idx, open]);

  // Hasil menyusut saat pencarian dipersempit atau saat hasil data tiba.
  // Indeks yang tertinggal di luar batas membuat Enter tidak melakukan apa pun.
  useEffect(() => {
    setIdx((current) => (current > results.length - 1 ? Math.max(0, results.length - 1) : current));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  async function run(item: Item) {
    close();
    if (item.href) router.push(item.href);
    else if (item.action) await item.action();
  }

  return (
    <>
      <button
        type="button"
        className="chip shrink-0"
        aria-label={t("palette.open")}
        onClick={openPalette}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">{t("palette.open")}</span><span className="kbd ml-1 hidden sm:inline">⌘K</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]"
          style={{ background: "rgba(8, 12, 24, 0.55)", backdropFilter: "blur(2px)" }}
          onMouseDown={close}
        >
          <div
            className="card w-full max-w-xl overflow-hidden shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={t("palette.open")}
            onMouseDown={(e) => e.stopPropagation()}
            // `aria-modal` hanyalah janji; tanpa jebakan fokus Tab menembus ke
            // tabel dan tombol di belakang panel. Modul yang sama sudah dipakai
            // panel heatmap, alert, pergerakan, dan penjelajah SLOC.
            onKeyDown={trapFocus}
          >
            <div className="flex items-center gap-2 px-4"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                aria-label={t("palette.open")}
                // Pola combobox baku: fokus tetap di kotak ketik, panah hanya
                // memindahkan sorotan, dan pembaca layar mengumumkan baris yang
                // sedang disorot lewat `aria-activedescendant`. Sebelumnya
                // sorotan itu murni visual — pengguna pembaca layar menekan
                // Enter tanpa pernah diberi tahu apa yang akan terbuka.
                role="combobox"
                aria-expanded
                aria-controls="palette-results"
                aria-autocomplete="list"
                aria-activedescendant={results[idx] ? `palette-option-${idx}` : undefined}
                className="w-full bg-transparent py-3 text-sm outline-none"
                style={{ color: "var(--text)" }}
                placeholder={t("palette.placeholder")}
                value={q}
                onChange={(e) => { setQ(e.target.value); setIdx(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
                  if (e.key === "Enter" && results[idx]) run(results[idx]);
                }}
              />
              <span className="kbd shrink-0">esc</span>
            </div>
            <div
              ref={listRef}
              id="palette-results"
              role="listbox"
              aria-label={t("palette.open")}
              className="max-h-[52vh] overflow-y-auto py-1"
            >
              {grouped.map(({ group, items }) => (
                <div key={group} role="group" aria-label={groupLabel[group]}>
                  <div className="eyebrow px-4 pb-1 pt-2.5" aria-hidden>{groupLabel[group]}</div>
                  {items.map((r) => {
                    const flatIndex = results.indexOf(r);
                    const active = flatIndex === idx;
                    return (
                      <button key={r.id}
                        id={`palette-option-${flatIndex}`}
                        data-palette-index={flatIndex}
                        role="option"
                        aria-selected={active}
                        // Fokus tinggal di kotak ketik, jadi barisnya tidak ikut
                        // urutan Tab — kalau tidak, Tab dan panah akan menggerakkan
                        // dua sorotan berbeda pada daftar yang sama.
                        tabIndex={-1}
                        className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px]"
                        style={{
                          background: active ? "var(--accent-soft)" : "transparent",
                          color: "var(--text)",
                          borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                        }}
                        onMouseEnter={() => setIdx(flatIndex)}
                        onClick={() => run(r)}>
                        <span className="min-w-0 truncate">{r.label}</span>
                        <span className="eyebrow shrink-0">{r.hint}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {!results.length && (
                <div className="px-4 py-8 text-center text-xs" role="status"
                  style={{ color: "var(--text-muted)" }}>
                  {t("palette.noResults").replace("{query}", q)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 px-4 py-2 text-[10.5px]"
              style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
              <span><span className="kbd">↑↓</span> {t("palette.select")}</span>
              <span><span className="kbd">↵</span> {t("palette.openItem")}</span>
              <span className="ml-auto">{t("palette.searchHint")}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
