// Helper i18n sisi SERVER (membaca cookie). Kamus ada di lib/i18n-dict.ts.
import { cookies } from "next/headers";
import { makeT, LANG_COOKIE, type Lang, type TFn } from "@/lib/i18n-dict";

export type { Lang, TFn };
export { makeT, LANG_COOKIE, localeOf } from "@/lib/i18n-dict";

export async function getLang(): Promise<Lang> {
  const v = (await cookies()).get(LANG_COOKIE)?.value;
  return v === "en" ? "en" : "id";
}

export async function getT(): Promise<TFn> {
  return makeT(await getLang());
}
