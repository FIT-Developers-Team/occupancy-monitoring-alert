"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LANG_COOKIE } from "@/lib/i18n-dict";
import { useT } from "@/lib/i18n-client";

export default function LangSwitch() {
  const router = useRouter();
  const { t } = useT();
  const [lang, setLang] = useState("id");
  useEffect(() => {
    const m = document.cookie.match(new RegExp(`${LANG_COOKIE}=(en|id)`));
    if (m) setLang(m[1]);
  }, []);
  function pick(v: string) {
    setLang(v);
    document.cookie = `${LANG_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
    window.dispatchEvent(new Event("wiom:language"));
    router.refresh();
  }
  return (
    <div className="seg" role="group" aria-label={t("shell.language")}>
      {[["id", "ID"], ["en", "EN"]].map(([v, label]) => (
        <button key={v} onClick={() => pick(v)} aria-pressed={lang === v}
          className={`seg-item ${lang === v ? "seg-item-active" : ""}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
