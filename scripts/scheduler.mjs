// Small in-container scheduler for Docker deployments. It keeps alert
// evaluation independent from browser activity and sends the daily summary at
// 08:00 Asia/Jakarta. Systemd users can use the matching timers in deploy/.
const base = (process.env.SCHEDULER_BASE_URL || "http://web:3000").replace(/\/$/, "");
const secret = process.env.CRON_SECRET;
const tickMs = Math.max(60_000, Number(process.env.TICK_INTERVAL_MS || 300_000));
let sentDaily = "";

if (!secret) {
  console.error("CRON_SECRET wajib diisi; scheduler tidak dijalankan.");
  process.exit(1);
}

async function call(path) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    console.log(`${new Date().toISOString()} ${path} OK`);
  } catch (error) {
    console.error(`${new Date().toISOString()} ${path} gagal: ${error.message}`);
  }
}

function jakartaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

async function dailyIfDue() {
  const now = jakartaNow();
  if (now.hour === 8 && now.minute < 5 && sentDaily !== now.date) {
    sentDaily = now.date;
    await call("/api/cron/daily-summary");
  }
}

await call("/api/cron/tick");
setInterval(() => { void call("/api/cron/tick"); }, tickMs);
setInterval(() => { void dailyIfDue(); }, 60_000);
void dailyIfDue();
