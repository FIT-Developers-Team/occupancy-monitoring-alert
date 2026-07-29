// Mode tampilan basis okupansi (cookie) — status & alert SELALU ikut kebijakan.
import { cookies } from "next/headers";
import type { BasisMode } from "@/types";
export { pickViewPct as pickPct, pickViewStatus as pickStatus } from "@/lib/occupancy-view";

export const BASIS_COOKIE = "wiom_basis";

export async function getBasisMode(): Promise<BasisMode> {
  const v = (await cookies()).get(BASIS_COOKIE)?.value;
  return v === "qty" || v === "cbm" || v === "bin" ? v : "policy";
}

export const basisLabel: Record<BasisMode, string> = {
  policy: "Kebijakan", qty: "Qty", cbm: "CBM", bin: "Bin",
};
