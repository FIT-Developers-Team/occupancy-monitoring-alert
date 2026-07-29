"use client";
// Basis tampilan: Kebijakan · Qty · CBM · Bin. Status & alert tetap basis kebijakan.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n-client";

const COOKIE = "wiom_basis";
const OPTIONS = ["policy", "qty", "cbm", "bin"] as const;

export default function BasisSwitch() {
  const router = useRouter();
  const { t } = useT();
  const [mode, setMode] = useState<string>("policy");

  useEffect(() => {
    const refresh = () => {
      const m = document.cookie.match(new RegExp(`${COOKIE}=(qty|cbm|bin|policy)`));
      setMode(m?.[1] ?? "policy");
    };
    refresh();
    window.addEventListener("wiom:basis", refresh);
    return () => window.removeEventListener("wiom:basis", refresh);
  }, []);

  function select(v: string) {
    setMode(v);
    document.cookie = `${COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
    window.dispatchEvent(new Event("wiom:basis"));
    router.refresh();
  }

  return (
    <div className="seg" title={t("basis.hint")} role="group" aria-label={t("basis.label")}>
      {OPTIONS.map((v) => (
        <button key={v} onClick={() => select(v)} aria-pressed={mode === v}
          className={`seg-item ${mode === v ? "seg-item-active" : ""}`}
          title={v === "bin" ? t("basis.binHint") : undefined}>
          {t(`basis.${v}`)}
        </button>
      ))}
    </div>
  );
}
