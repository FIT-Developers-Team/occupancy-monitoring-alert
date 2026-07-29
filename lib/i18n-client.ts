"use client";
// Terjemahan sisi klien — membaca cookie yang sama dengan server.
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { makeT, type Lang, type TFn, LANG_COOKIE } from "@/lib/i18n-dict";

const LangContext = createContext<Lang>("id");

export function readLang(): Lang {
  if (typeof document === "undefined") return "id";
  return document.cookie.match(new RegExp(`${LANG_COOKIE}=(en|id)`))?.[1] === "en" ? "en" : "id";
}

export function I18nProvider({
  initialLang,
  children,
}: {
  initialLang: Lang;
  children: ReactNode;
}) {
  const [lang, setLang] = useState<Lang>(initialLang);
  useEffect(() => {
    setLang(initialLang);
    const refresh = () => setLang(readLang());
    window.addEventListener("wiom:language", refresh);
    return () => window.removeEventListener("wiom:language", refresh);
  }, [initialLang]);
  return createElement(LangContext.Provider, { value: lang }, children);
}

export function useT(): { t: TFn; lang: Lang } {
  const lang = useContext(LangContext);
  const t = useMemo(() => makeT(lang), [lang]);
  return { t, lang };
}
