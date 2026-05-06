import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws }
});
const EPA_DUMP_URL = "https://www3.epa.gov/pesticides/appril/apprildatadump_public.xlsx";

function nyNow() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function getLoose(rec, ...keys) {
  const idx = {};
  for (const k of Object.keys(rec || {})) idx[norm(k)] = rec[k];
  for (const k of keys) {
    const v = idx[norm(k)];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function mapRow(r) {
  const epa = String(getLoose(r, "reg_num", "registration number", "registration_number") || "").trim();
  const name = String(getLoose(r, "product_name", "product name") || "").trim();
  if (!epa || !name) return null;
  return {
    epa_number:         epa,
    reg_num:            epa,
    product_name:       name,
    active_ingredient:  String(getLoose(r, "ais", "active ingredient(s)", "active ingredients") || "").trim(),
    active_ingredients: String(getLoose(r, "ais", "active ingredient(s)", "active ingredients") || "").trim(),
    signal_word:        String(getLoose(r, "signal_word", "signal word") || "").trim(),
    product_type:       String(getLoose(r, "pesticide_type", "pesticide type", "reg_type", "reg type") || "").trim(),
    pesticide_type:     String(getLoose(r, "pesticide_type", "pesticide type") || "").trim(),
    status_group:       String(getLoose(r, "status_group", "status group") || "").trim(),
    status:             String(getLoose(r, "status") || "").trim(),
    use_pattern:        String(getLoose(r, "use_pattern", "use pattern") || "").trim(),
    company_name:       String(getLoose(r, "company_name", "company name") || "").trim(),
    source:             "EPA_APPRIL",
    last_synced_at:     new Date().toISOString(),
  };
}

async function run() {
  const now = nyNow();
  const isMonday = now.weekday === "Mon";
  const is7pmHour = Number(now.hour) === 19;
  const isManual = process.env.MANUAL_RUN === "true";

  if (!isManual && (!isMonday || !is7pmHour)) {
    console.log("Skipping: outside Monday 7PM ET window. Set MANUAL_RUN=true to force.");
    return;
  }

  if (isManual) console.log("Manual run — bypassing time gate.");

  const weekKey = isoWeekKey();

  const { data: done } = await sb
    .from("chemical_sync_runs")
    .select("id")
    .eq("week_key", weekKey)
    .eq("status", "success")
    .limit(1);

  if (done?.length) {
    console.log("Already synced this week:", weekKey);
    return;
  }

  const { data: runRow, error: runErr } = await sb
    .from("chemical_sync_runs")
    .insert({ run_type: "scheduled", week_key: weekKey, status: "running", message: "GitHub sync start" })
    .select("id")
    .single();

  if (runErr) throw runErr;
  console.log("Run ID:", runRow.id, "Week:", weekKey);

  try {
    console.log("Fetching EPA APPRIL dump (~93MB)...");
    const res = await fetch(EPA_DUMP_URL, { redirect: "follow" });
    console.log(`EPA response: ${res.status} ${res.statusText}`);
    console.log(`Content-Type: ${res.headers.get("content-type")}`);
    console.log(`Content-Length: ${res.headers.get("content-length")}`);
    if (!res.ok) throw new Error(`EPA fetch failed: ${res.status} ${res.statusText}`);

    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    if (buf.length < 10000) {
      console.log("Response too small, first 500 chars:", buf.toString("utf8").slice(0, 500));
      throw new Error(`EPA returned ${buf.length} bytes — likely HTML not Excel. Check the download URL.`);
    }

    const wb = XLSX.read(buf, {
      type: "buffer",
      dense: true,
      cellText: false,
      cellDates: false,
    });
    const sheet = wb.SheetNames?.[0];
    if (!sheet) throw new Error("EPA workbook missing sheet");

    console.log("Parsing sheet:", sheet);
    console.log("Sheet ref:", wb.Sheets[sheet]["!ref"] || "unknown");

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], {
      defval: "",
      raw: false,
    });
    console.log(`Total rows: ${rows.length.toLocaleString()}`);
    if (rows.length > 0) console.log("Columns detected:", Object.keys(rows[0]).join(", "));

    const filtered = rows.filter((r) => {
      const s = String(getLoose(r, "status_group", "status group") || "").toLowerCase();
      const t = String(getLoose(r, "reg_type", "reg type", "registration type") || "").toLowerCase();
      return s === "active" && (t === "sec3" || t === "" || t.includes("3"));
    });

    console.log(`Active SEC3 records: ${filtered.length.toLocaleString()}`);

    const mapped = filtered.map(mapRow).filter(Boolean);
    console.log(`Records to upsert: ${mapped.length.toLocaleString()}`);

    let upserted = 0;
    const BATCH = 500;
    for (let i = 0; i < mapped.length; i += BATCH) {
      const batch = mapped.slice(i, i + BATCH);
      const { error } = await sb.from("chemical_library").upsert(batch, { onConflict: "epa_number" });
      if (error) throw new Error(`Batch ${i} failed: ${error.message}`);
      upserted += batch.length;
      if (i % 10000 === 0 && i > 0) console.log(`  ${i.toLocaleString()} / ${mapped.length.toLocaleString()} upserted...`);
    }

    await sb.from("chemical_sync_runs").update({
      status:        "success",
      rows_fetched:  rows.length,
      rows_upserted: upserted,
      message:       "GitHub sync complete",
      finished_at:   new Date().toISOString(),
    }).eq("id", runRow.id);

    console.log(`\n✅ Done. fetched=${rows.length.toLocaleString()}, upserted=${upserted.toLocaleString()}`);

  } catch (e) {
    await sb.from("chemical_sync_runs").update({
      status:      "failed",
      message:     e.message,
      finished_at: new Date().toISOString(),
    }).eq("id", runRow.id);
    throw e;
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
