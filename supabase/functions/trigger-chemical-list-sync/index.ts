import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const jsonHeaders = { ...cors, "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: jsonHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "Missing authorization" }, { status: 401, headers: jsonHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    return Response.json({ error: "Server configuration error" }, { status: 500, headers: jsonHeaders });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: "Invalid session" }, { status: 401, headers: jsonHeaders });
  }

  const githubToken = Deno.env.get("GITHUB_DISPATCH_TOKEN")?.trim();
  if (!githubToken) {
    console.error("GITHUB_DISPATCH_TOKEN is not set");
    return Response.json(
      {
        error:
          "GitHub token missing: set Edge Function secret GITHUB_DISPATCH_TOKEN (PAT with Actions: write on the repo).",
      },
      { status: 500, headers: jsonHeaders },
    );
  }

  const repo = (Deno.env.get("GITHUB_REPO") || "jflembc/SpraylogPro").trim();
  const workflowFile = (Deno.env.get("GITHUB_WORKFLOW_FILE") || "epa-sync.yml").trim();
  const ref = (Deno.env.get("GITHUB_WORKFLOW_REF") || "main").trim();

  let body: { force?: boolean } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as { force?: boolean };
  } catch {
    body = {};
  }

  const forceInput = body.force === false ? "false" : "true";

  const dispatchUrl =
    `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;

  const ghRes = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref,
      inputs: { force: forceInput },
    }),
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    console.error("GitHub workflow_dispatch failed:", ghRes.status, text);
    let detail = text.slice(0, 500);
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j?.message) detail = j.message;
    } catch {
      /* keep truncated body */
    }
    return Response.json(
      {
        error: `GitHub returned ${ghRes.status}`,
        detail,
      },
      { status: 502, headers: jsonHeaders },
    );
  }

  return Response.json(
    {
      ok: true,
      message: "EPA sync workflow started. Wait a few minutes, then load products.",
    },
    { headers: jsonHeaders },
  );
});
