/**
 * Parse agrian_kansas_label_list05122026.md (markdown table) and upsert into Supabase state_label_products.
 *
 * Usage (from SprayLog App folder):
 *   set SUPABASE_URL=https://xxx.supabase.co
 *   set SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *   node scripts/import-kansas-md.mjs "agrian_kansas_label_list05122026.md" KS
 *
 * Requires: npm i @supabase/supabase-js
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const EPA_RE = /\b\d{3,5}-\d{2,3}(?:-\d+)?\b/;

function extractRegNorm(cell) {
  const s = String(cell || "").trim();
  const m = s.match(EPA_RE);
  return m ? m[0].toLowerCase() : "";
}

function normNameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 120);
}

function parseMdTable(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (/^\|\s*---/.test(t)) continue;
    if (/^\|\s*Product\s*\|/i.test(t)) continue;
    const parts = t
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    if (parts.length < 2) continue;
    const [product, regCol, ai, distributor, registrant] = [
      parts[0] || "",
      parts[1] || "",
      parts[2] || "",
      parts[3] || "",
      parts[4] || "",
    ];
    if (/^product$/i.test(product)) continue;
    const product_name = product.trim();
    if (!product_name) continue;
    const reg_raw = String(regCol || "").trim();
    const reg_normalized = extractRegNorm(reg_raw) || extractRegNorm(product_name);
    rows.push({
      product_name,
      reg_raw,
      reg_normalized,
      active_ingredient: String(ai || "").trim(),
      distributor: String(distributor || "").trim(),
      registrant: String(registrant || "").trim(),
    });
  }
  return rows;
}

async function main() {
  const mdPath = resolve(process.argv[2] || "agrian_kansas_label_list05122026.md");
  const state = (process.argv[3] || "KS").toUpperCase().slice(0, 2);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const parsed = parseMdTable(mdPath);
  const seen = new Set();
  const deduped = [];
  for (const r of parsed) {
    const k = state + '|' + r.product_name + '\n' + r.reg_raw;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }
  console.log("Parsed rows:", parsed.length, "unique:", deduped.length, "from", mdPath);
  if (!deduped.length) {
    console.error("No rows found. Check markdown table format.");
    process.exit(1);
  }
  const batchSize = 400;
  let ok = 0;
  for (let i = 0; i < deduped.length; i += batchSize) {
    const chunk = deduped.slice(i, i + batchSize).map((r) => ({
      state_code: state,
      product_name: r.product_name,
      reg_raw: r.reg_raw,
      reg_normalized: r.reg_normalized,
      active_ingredient: r.active_ingredient,
      source: "AGRIAN_EXPORT",
    }));
    const { error } = await sb.from("state_label_products").upsert(chunk, {
      onConflict: "state_code,product_name,reg_raw",
    });
    if (error) {
      console.error("Upsert error at", i, error.message);
      process.exit(1);
    }
    ok += chunk.length;
    console.log("Upserted", ok, "/", deduped.length);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
