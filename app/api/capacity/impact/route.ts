// Berapa lokasi yang benar-benar disentuh tiap aturan kapasitas — dihitung dari
// aturan yang SEDANG DIEDIT, bukan yang sudah tersimpan.
//
// Editor kapasitas sebelumnya tidak memberi umpan balik apa pun: sebuah aturan
// dengan zona salah ketik terlihat persis sama dengan aturan yang mengatur
// belasan ribu lokasi. Endpoint ini menjawab dua pertanyaan yang membedakannya —
// "cocok dengan berapa lokasi" dan "berapa di antaranya yang benar-benar
// memakai nilai ini" — sehingga aturan mati dan aturan tertutup dapat dikenali
// sebelum disimpan, bukan berbulan-bulan sesudahnya.
import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { capacityRuleImpact } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/** Batas atas kasar; editor tidak pernah mengirim lebih banyak dari ini. */
const MAX_RULES = 500;

interface IncomingRule {
  scope?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

function sanitizeRule(rule: IncomingRule) {
  const scope: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule.scope ?? {})) {
    if (typeof value === "string" && value.trim()) scope[key] = value.trim();
  }
  const raw = rule.set ?? {};
  const numeric = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;
  return {
    scope,
    set: {
      basis: raw.basis === "qty" || raw.basis === "cbm" ? raw.basis : undefined,
      max_qty: numeric("max_qty"),
      max_cbm: numeric("max_cbm"),
      utilization_pct: numeric("utilization_pct"),
      count: typeof raw.count === "boolean" ? raw.count : undefined,
    },
  };
}

export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403, headers: NO_STORE });
  }
  const body = await request.json().catch(() => null) as { rules?: IncomingRule[] } | null;
  const incoming = Array.isArray(body?.rules) ? body.rules : null;
  if (!incoming) {
    return NextResponse.json({ error: "Body JSON tidak valid." }, { status: 400, headers: NO_STORE });
  }
  if (incoming.length > MAX_RULES) {
    return NextResponse.json(
      { error: `Terlalu banyak aturan untuk dipratinjau (maksimum ${MAX_RULES}).` },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const impact = await capacityRuleImpact(incoming.map(sanitizeRule));
    return NextResponse.json({ impact }, { headers: NO_STORE });
  } catch (error) {
    // Pratinjau adalah bantuan, bukan syarat menyimpan. Kegagalannya —
    // snapshot SLOC belum ada, DuckDB sedang terkunci — tidak boleh membuat
    // editor tampak rusak.
    return NextResponse.json(
      { error: (error as Error).message, impact: [] },
      { status: 200, headers: NO_STORE },
    );
  }
}
