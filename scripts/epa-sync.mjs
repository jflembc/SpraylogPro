import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MANUAL_RUN = process.env.MANUAL_RUN === "1";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const EPA_DUMP_URL =
  "https://www3.epa.gov/pesticides/appril/apprildatadump_public.xlsx";

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

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

function nyGateAllowsRun() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const weekday = parts.weekday;
  const hour = Number(parts.hour);
  return weekday === "Mon" && hour === 19;
}

function mapRow(r) {
  const epa = String(
    getLoose(r, "reg_num", "registration number", "registration_number") || ""
  ).trim();
  const name = String(getLoose(r, "product_name", "product name") || "").trim();
  if (!epa || !name) return null;

  return {
    epa_number: epa,
    reg_num: epa,
    product_name: name,
    active_ingredient: String(
      getLoose(r, "ais", "active ingredient(s)", "active ingredients") || ""
    ).trim(),
    signal_word: String(getLoose(r, "signal_word", "signal word") || "").trim(),
    product_type: String(
      getLoose(r, "pesticide_type", "pesticide type", "reg_type", "reg type") || ""
    ).trim(),
    pesticide_type: String(getLoose(r, "pesticide_type", "pesticide type") || "").trim(),
    status_group: String(getLoose(r, "status_group", "status group") || "").trim(),
    status: String(getLoose(r, "status") || "").trim(),
    use_pattern: String(getLoose(r, "use_pattern", "use pattern") || "").trim(),
    company_name: String(getLoose(r, "company_name", "company name") || "").trim(),
    source: "EPA_APPRIL",
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function loadRowsFromXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const ws =
    workbook.getWorksheet("ACTIVE_REGISTRATIONS5_PUBLIC_V") ||
    workbook.worksheets[0];

  if (!ws) throw new Error("No worksheet found in EPA workbook.");

  let headers = [];
  const rows = [];

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      let v = cell.value;
      if (v && typeof v === "object") {
        if ("text" in v) v = v.text;
        else if ("result" in v) v = v.result;
        else if ("richText" in v) v = v.richText?.map((t) => t.text).join("") ?? "";
        else v = String(v);
      }
      vals.push(v ?? "");
    });

    if (rowNumber === 1) {
      headers = vals.map((h) => String(h || "").trim());
      return;
    }

    const obj = {};
    headers.forEach((h, i) => {
      if (!h) return;
      obj[h] = vals[i] ?? "";
    });
    rows.push(obj);
  });

  return rows;
}

async function run() {
  const weekKey = isoWeekKey();

  if (!MANUAL_RUN && !nyGateAllowsRun()) {
    console.log("Skipping: outside Monday 7:00 PM America/New_York window.");
    return;
  }

  if (MANUAL_RUN) console.log("Manual run: bypassing time gate.");

  const { data: done, error: dupErr } = await sb
    .from("chemical_sync_runs")
    .select("id")
    .eq("week_key", weekKey)
    .eq("status", "success")
    .limit(1);

  if (dupErr) throw dupErr;
  if (!MANUAL_RUN && done?.length) {
    console.log("Already synced this week:", weekKey);
    return;
  }

  const { data: runRow, error: runErr } = await sb
    .from("chemical_sync_runs")
    .insert({
      run_type: MANUAL_RUN ? "manual" : "scheduled",
      week_key: weekKey,
      status: "running",
      message: "EPA GitHub sync started",
    })
    .select("id")
    .single();

  if (runErr) throw runErr;
  const runId = runRow.id;

  try {
    console.log("Fetching EPA dump...");
    const res = await fetch(EPA_DUMP_URL);
    if (!res.ok) throw new Error(`EPA dump HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

    console.log("Parsing with ExcelJS...");
    const rows = await loadRowsFromXlsx(buf);
    console.log(`Parsed ${rows.length} rows`);

    const filtered = rows.filter((r) => {
      const s = String(getLoose(r, "status_group", "status group") || "").toLowerCase();
      const t = String(getLoose(r, "reg_type", "reg type") || "").toLowerCase();
      return s === "active" && t === "sec3";
    });

    const mapped = filtered.map(mapRow).filter(Boolean);
    console.log(`Filtered to ${mapped.length} active Sec3 rows`);

    let upserted = 0;
    const BATCH = 500;
    for (let i = 0; i < mapped.length; i += BATCH) {
      const batch = mapped.slice(i, i + BATCH);
      const { error } = await sb.from("chemical_library").upsert(batch, {
        onConflict: "epa_number",
      });
      if (error) throw error;
      upserted += batch.length;
      if (upserted % 5000 === 0 || upserted === mapped.length) {
        console.log(`Upserted ${upserted} / ${mapped.length}`);
      }
    }

    await sb
      .from("chemical_sync_runs")
      .update({
        status: "success",
        rows_fetched: rows.length,
        rows_upserted: upserted,
        message: "EPA GitHub sync complete",
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    console.log(`Done. week=${weekKey} fetched=${rows.length} upserted=${upserted}`);
  } catch (e) {
    await sb
      .from("chemical_sync_runs")
      .update({
        status: "failed",
        message: String(e?.message || e),
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);
    throw e;
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
