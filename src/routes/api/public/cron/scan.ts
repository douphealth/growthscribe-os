import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

function dateKey() {
  return new Date().toISOString().slice(0, 10);
}

// Public cron endpoint: scheduled by pg_cron. It enqueues one deterministic
// technical scan and one Hermes portfolio decision cycle per active site/day.
// Live mutations remain controlled by autonomy_policies in the worker.
export const Route = createFileRoute("/api/public/cron/scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!apikey || !expected || apikey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = process.env.SUPABASE_URL;
        const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !service) {
          return new Response("Server not configured", { status: 500 });
        }
        const admin = createClient<Database>(url, service, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: sites, error } = await admin
          .from("sites")
          .select("id, organization_id, owner_id, name, status")
          .in("status", ["connected", "sync_running"]);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }

        let technicalQueued = 0;
        let autonomyQueued = 0;
        const day = dateKey();
        for (const s of sites ?? []) {
          const jobs = [
            {
              job_type: "technical.scan",
              priority: 20,
              idempotency_key: `cron:${s.id}:${day}:technical.scan`,
              payload: { source: "cron", scheduledAt: new Date().toISOString() },
            },
            {
              job_type: "autonomy.portfolio",
              priority: 100,
              idempotency_key: `cron:${s.id}:${day}:autonomy.portfolio`,
              payload: { source: "daily-cron", scheduledAt: new Date().toISOString() },
            },
          ];
          for (const candidate of jobs) {
            const { data: existing } = await admin
              .from("background_jobs")
              .select("id")
              .eq("idempotency_key", candidate.idempotency_key)
              .maybeSingle();
            if (existing) continue;
            const { error: jobErr } = await admin.from("background_jobs").insert({
              organization_id: s.organization_id,
              site_id: s.id,
              created_by: s.owner_id,
              status: "queued",
              ...candidate,
            });
            if (!jobErr) {
              if (candidate.job_type === "technical.scan") technicalQueued++;
              else autonomyQueued++;
            }
          }
        }
        return new Response(
          JSON.stringify({
            ok: true,
            technicalQueued,
            autonomyQueued,
            totalSites: sites?.length ?? 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
