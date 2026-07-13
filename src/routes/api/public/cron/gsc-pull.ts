import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { computeWindow, enqueueGscPullJob, sanitizeGscError } from "@/lib/gsc-import.server";

// Scheduler only: GSC API access and analytics writes are owned exclusively by
// runGscImportJob in the background worker.
export const Route = createFileRoute("/api/public/cron/gsc-pull")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!apikey || !expected || apikey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const url = process.env.SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !serviceRoleKey) {
          return Response.json({ ok: false, error: "Server not configured" }, { status: 500 });
        }
        const admin = createClient<Database>(url, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data: connections, error } = await admin
          .from("integration_connections")
          .select("organization_id, site_id, created_by")
          .eq("provider", "gsc")
          .eq("status", "connected");
        if (error) {
          return Response.json({ ok: false, error: sanitizeGscError(error) }, { status: 500 });
        }

        const window = computeWindow(3);
        const results: Array<{
          siteId: string;
          ok: boolean;
          jobId?: string;
          created?: boolean;
          error?: string;
        }> = [];

        for (const connection of connections ?? []) {
          if (!connection.site_id) continue;
          try {
            const queued = await enqueueGscPullJob(admin, {
              organizationId: connection.organization_id,
              siteId: connection.site_id,
              createdBy: connection.created_by,
              startDate: window.startDate,
              endDate: window.endDate,
              trigger: "cron",
            });
            results.push({
              siteId: connection.site_id,
              ok: true,
              jobId: queued.jobId,
              created: queued.created,
            });
          } catch (enqueueError) {
            results.push({
              siteId: connection.site_id,
              ok: false,
              error: sanitizeGscError(enqueueError),
            });
          }
        }

        return Response.json({
          ok: results.every((result) => result.ok),
          scheduled: results.filter((result) => result.created).length,
          reused: results.filter((result) => result.ok && !result.created).length,
          failed: results.filter((result) => !result.ok).length,
          window,
          results,
        });
      },
    },
  },
});
