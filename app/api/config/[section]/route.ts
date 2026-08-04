import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { writeSection, getThresholds, getRules, getRecipients, getWarehouses, getCapacity, whMapSQL, type ConfigSection, type RecipientsConfig } from "@/lib/config";
import { queryHistory } from "@/lib/db";
import { audit } from "@/lib/audit";
import { invalidateOccupancyReadCaches } from "@/lib/queries";

const readers: Record<ConfigSection, () => unknown> = {
  thresholds: getThresholds, rules: getRules, recipients: getRecipients,
  warehouses: getWarehouses, capacity: getCapacity,
};

/** Meta utk editor kapasitas: nilai distinct dari DB (WH, zona, storage, kategori, status). */
async function capacityMeta() {
  const configuredWarehouses = getWarehouses().warehouses.map((warehouse) => warehouse.code);
  try {
    const whMap = `WITH ${whMapSQL()}`;
    const active = "v.active AND nullif(trim(v.sloc_code), '') IS NOT NULL";
    const operational = `${active} AND nullif(trim(v.zone), '') IS NOT NULL`;
    const [zones, rackZones, levels, storages, cats, statuses] = await Promise.all([
      queryHistory<{ wh: string; zone: string }>(`${whMap} SELECT DISTINCT m.wh, v.zone FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} ORDER BY 1,2`),
      queryHistory<{ wh: string; zone: string; rack_zone: string }>(`${whMap} SELECT DISTINCT m.wh, v.zone, coalesce(v.rack_zone,'') AS rack_zone FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${operational} AND coalesce(v.rack_zone,'')<>'' ORDER BY 1,2,3`),
      queryHistory<{ level: string }>(`${whMap} SELECT DISTINCT coalesce(v.level,'') AS level FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${active} AND coalesce(v.level,'')<>'' ORDER BY 1`),
      queryHistory<{ s: string }>(`${whMap} SELECT DISTINCT coalesce(v.storage_handling,'') AS s FROM vw_sloc v JOIN wh_map m ON m.location_id=v.location_id WHERE ${active} AND coalesce(v.storage_handling,'')<>'' ORDER BY 1`),
      queryHistory<{ c: string }>(`${whMap} SELECT DISTINCT coalesce(s.l1_category,'') AS c FROM vw_stock_latest s JOIN vw_sloc v ON v.sloc_code=s.sloc_code AND v.location_id=s.location_id JOIN wh_map m ON m.location_id=v.location_id WHERE ${active} AND coalesce(s.l1_category,'')<>'' ORDER BY 1`),
      queryHistory<{ s: string }>(`${whMap} SELECT DISTINCT coalesce(s.status,'') AS s FROM vw_stock_latest s JOIN vw_sloc v ON v.sloc_code=s.sloc_code AND v.location_id=s.location_id JOIN wh_map m ON m.location_id=v.location_id WHERE ${active} AND coalesce(s.status,'')<>'' ORDER BY 1`),
    ]);
    const zonesByWh: Record<string, string[]> = {};
    for (const z of zones) (zonesByWh[z.wh] ??= []).push(z.zone);
    const racksByWhZone: Record<string, string[]> = {};
    for (const r of rackZones) (racksByWhZone[`${r.wh}|${r.zone}`] ??= []).push(r.rack_zone);
    return {
      // Warehouse choices are configuration, not an accidental consequence of
      // data completeness. Keep the editor usable even while a fresh SLOC
      // sync has not populated zones yet.
      warehouses: configuredWarehouses,
      zones: zonesByWh,
      rack_zones: racksByWhZone,
      levels: levels.map((x) => x.level),
      storages: storages.map((x) => x.s),
      categories: cats.map((x) => x.c),
      statuses: statuses.map((x) => x.s),
    };
  } catch {
    return {
      warehouses: configuredWarehouses,
      zones: {}, rack_zones: {}, levels: [], storages: [], categories: [], statuses: [],
    };
  }
}

function valid(section: string): section is ConfigSection {
  return section in readers;
}

function auditSafeConfig(section: ConfigSection, value: unknown): unknown {
  if (section !== "recipients") return value;
  const recipients = value as RecipientsConfig;
  return {
    severity_start_level: recipients.severity_start_level,
    levels: recipients.levels.map((level) => ({
      level: level.level,
      name: level.name,
      delay_minutes: level.delay_minutes,
      gchat_routes: level.gchat_routes.map((route) => ({
        id: route.id,
        label: route.label,
        enabled: route.enabled,
        warehouse_codes: route.warehouse_codes,
        mention_count: route.mention_targets.length,
        webhook_configured: Boolean(route.webhook_url),
      })),
      legacy_gchat_webhook_count: level.gchat_webhooks.length,
      email_count: level.emails.length,
      generic_webhook_count: level.webhooks.length,
    })),
  };
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
    await audit(
      user.username,
      "CONFIG_UPDATE",
      `config:${section}`,
      auditSafeConfig(section, before),
      auditSafeConfig(section, after),
    );
    return NextResponse.json({ section, data: after });
  } catch (e) {
    return NextResponse.json(
      { error: `Validasi gagal: ${(e as Error).message}` },
      { status: 400 }
    );
  }
}
