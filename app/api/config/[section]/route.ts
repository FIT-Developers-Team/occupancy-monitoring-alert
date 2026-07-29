import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { writeSection, getThresholds, getRules, getRecipients, getWarehouses, getCapacity, whMapSQL, type ConfigSection } from "@/lib/config";
import { queryHistory } from "@/lib/db";
import { audit } from "@/lib/audit";
import { invalidateOccupancyReadCaches } from "@/lib/queries";

const readers: Record<ConfigSection, () => unknown> = {
  thresholds: getThresholds, rules: getRules, recipients: getRecipients,
  warehouses: getWarehouses, capacity: getCapacity,
};

/** Meta utk editor kapasitas: nilai distinct dari DB (WH, zona, storage, kategori, status). */
async function capacityMeta() {
  try {
    const whMap = `WITH ${whMapSQL()}`;
    const operational = "v.active AND nullif(trim(v.sloc_code), '') IS NOT NULL AND nullif(trim(v.zone), '') IS NOT NULL";
    const [whs, zones, rackZones, levels, storages, cats, statuses] = await Promise.all([
      queryHistory<{ wh: string }>(`${whMap} SELECT DISTINCT m.wh FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} ORDER BY 1`),
      queryHistory<{ wh: string; zone: string }>(`${whMap} SELECT DISTINCT m.wh, v.zone FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} ORDER BY 1,2`),
      queryHistory<{ wh: string; zone: string; rack_zone: string }>(`${whMap} SELECT DISTINCT m.wh, v.zone, coalesce(v.rack_zone,'') AS rack_zone FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} AND coalesce(v.rack_zone,'')<>'' ORDER BY 1,2,3`),
      queryHistory<{ level: string }>(`${whMap} SELECT DISTINCT coalesce(v.level,'') AS level FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} AND coalesce(v.level,'')<>'' ORDER BY 1`),
      queryHistory<{ s: string }>(`${whMap} SELECT DISTINCT v.storage_handling AS s FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} ORDER BY 1`),
      queryHistory<{ c: string }>(`${whMap} SELECT DISTINCT coalesce(s.l1_category,'') AS c FROM vw_stock_latest s JOIN vw_sloc v ON v.sloc_code=s.sloc_code JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} AND coalesce(s.l1_category,'')<>'' ORDER BY 1`),
      queryHistory<{ s: string }>(`${whMap} SELECT DISTINCT s.status AS s FROM vw_stock_latest s JOIN vw_sloc v ON v.sloc_code=s.sloc_code JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} ORDER BY 1`),
    ]);
    const zonesByWh: Record<string, string[]> = {};
    for (const z of zones) (zonesByWh[z.wh] ??= []).push(z.zone);
    const racksByWhZone: Record<string, string[]> = {};
    for (const r of rackZones) (racksByWhZone[`${r.wh}|${r.zone}`] ??= []).push(r.rack_zone);
    return {
      warehouses: whs.map((w) => w.wh),
      zones: zonesByWh,
      rack_zones: racksByWhZone,
      levels: levels.map((x) => x.level),
      storages: storages.map((x) => x.s),
      categories: cats.map((x) => x.c),
      statuses: statuses.map((x) => x.s),
    };
  } catch { return null; }
}

function valid(section: string): section is ConfigSection {
  return section in readers;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ section: string }> }) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  const { section } = await ctx.params;
  if (!valid(section)) return NextResponse.json({ error: "Section tidak dikenal." }, { status: 404 });
  const meta = section === "capacity" ? await capacityMeta() : undefined;
  return NextResponse.json({ section, data: readers[section](), meta });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ section: string }> }) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  const { section } = await ctx.params;
  if (!valid(section)) return NextResponse.json({ error: "Section tidak dikenal." }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Body JSON tidak valid." }, { status: 400 });
  try {
    const before = readers[section]();
    const after = writeSection(section, body);
    // Capacity, warehouse allowlist, and thresholds all affect the read model.
    // Do not make an admin wait for the short in-process cache TTL.
    invalidateOccupancyReadCaches();
    await audit(user.username, "CONFIG_UPDATE", `config:${section}`, before, after);
    return NextResponse.json({ section, data: after });
  } catch (e) {
    return NextResponse.json(
      { error: `Validasi gagal: ${(e as Error).message}` },
      { status: 400 }
    );
  }
}
