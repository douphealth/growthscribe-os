import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Admin = SupabaseClient<Database>;

export type GscJobRow = {
  id: string;
  job_type: string;
  organization_id: string;
  site_id: string | null;
  payload: unknown;
  created_by: string;
};

export type GscWindow = {
  startDate: string;
  endDate: string;
  days: number;
};

type EnqueueGscPullInput = {
  organizationId: string;
  siteId: string;
  createdBy: string;
  startDate: string;
  endDate: string;
  trigger: "manual" | "cron" | "backfill";
};

const GSC_GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";
const ROW_LIMIT = 5_000;
const MAX_PAGES = 50;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseYmd(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || ymd(date) !== value ? null : value;
}

export function computeWindow(days: number, now = new Date()): GscWindow {
  const safeDays = Math.min(90, Math.max(1, Math.trunc(Number.isFinite(days) ? days : 28)));
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - safeDays);
  return { startDate: ymd(start), endDate: ymd(end), days: safeDays };
}

export function sanitizeGscError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown GSC error");
  return raw
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/(X-Connection-Api-Key\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .slice(0, 500);
}

export function gscDisableReason(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>).disabled_reason;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function gscConnectionLabel(status: string, reason: string | null) {
  if (status === "revoked" && reason === "duplicate_gsc_sync") {
    return { label: "Duplicate GSC sync disabled", showReconnect: false };
  }
  if (status === "connected") return { label: "Connected", showReconnect: false };
  return { label: "Reconnect required", showReconnect: true };
}

function parseJobWindow(payload: unknown): GscWindow {
  const value = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const startDate = parseYmd(value.start_date);
  const endDate = parseYmd(value.end_date);
  if (startDate && endDate) {
    if (startDate > endDate) throw new Error("GSC import start_date must not be after end_date");
    const days = Math.max(
      1,
      Math.round(
        (new Date(`${endDate}T00:00:00.000Z`).getTime() -
          new Date(`${startDate}T00:00:00.000Z`).getTime()) /
          86_400_000,
      ),
    );
    return { startDate, endDate, days };
  }
  return computeWindow(Number(value.days ?? 7));
}

export async function enqueueGscPullJob(admin: Admin, input: EnqueueGscPullInput) {
  const startDate = parseYmd(input.startDate);
  const endDate = parseYmd(input.endDate);
  if (!startDate || !endDate || startDate > endDate) throw new Error("Invalid GSC import window");

  const active = () =>
    admin
      .from("background_jobs")
      .select("id")
      .eq("job_type", "gsc.pull")
      .eq("site_id", input.siteId)
      .in("status", ["queued", "running"])
      .contains("payload", { start_date: startDate, end_date: endDate })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  const { data: existing, error: lookupError } = await active();
  if (lookupError) throw lookupError;
  if (existing) return { jobId: existing.id, created: false, window: { startDate, endDate } };

  const payload = {
    start_date: startDate,
    end_date: endDate,
    trigger: input.trigger,
  } as Json;
  const { data: inserted, error: insertError } = await admin
    .from("background_jobs")
    .insert({
      organization_id: input.organizationId,
      site_id: input.siteId,
      created_by: input.createdBy,
      job_type: "gsc.pull",
      status: "queued",
      payload,
    })
    .select("id")
    .single();

  if (!insertError && inserted) {
    return { jobId: inserted.id, created: true, window: { startDate, endDate } };
  }
  if (insertError?.code !== "23505") throw insertError;

  // A concurrent request won the race. Return its active job instead of surfacing a conflict.
  const { data: raced, error: raceLookupError } = await active();
  if (raceLookupError) throw raceLookupError;
  if (!raced) throw insertError;
  return { jobId: raced.id, created: false, window: { startDate, endDate } };
}

async function updateConnectionError(admin: Admin, job: GscJobRow, message: string | null) {
  if (!job.site_id) return;
  await admin
    .from("integration_connections")
    .update({ last_error: message })
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .eq("provider", "gsc");
}

export async function runGscImportJob(admin: Admin, job: GscJobRow) {
  if (!job.site_id) throw new Error("gsc.pull requires site_id");

  try {
    const { data: connection, error: connectionError } = await admin
      .from("integration_connections")
      .select("status, config")
      .eq("organization_id", job.organization_id)
      .eq("site_id", job.site_id)
      .eq("provider", "gsc")
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection || connection.status !== "connected") {
      throw new Error("Google Search Console connector is not connected for this site");
    }

    const config = (connection.config ?? {}) as Record<string, unknown>;
    const property = typeof config.property === "string" ? config.property : null;
    if (!property) throw new Error("GSC connection is missing its property config");

    const lovableApiKey = process.env.LOVABLE_API_KEY;
    const connectionApiKey = process.env.GOOGLE_SEARCH_CONSOLE_API_KEY;
    if (!lovableApiKey || !connectionApiKey) {
      throw new Error("GSC connector secrets are not configured");
    }

    const window = parseJobWindow(job.payload);
    const encodedProperty = encodeURIComponent(property);
    let totalRows = 0;
    let startRow = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetch(
        `${GSC_GATEWAY}/webmasters/v3/sites/${encodedProperty}/searchAnalytics/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableApiKey}`,
            "X-Connection-Api-Key": connectionApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startDate: window.startDate,
            endDate: window.endDate,
            dimensions: ["date", "query", "page"],
            rowLimit: ROW_LIMIT,
            startRow,
          }),
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`GSC ${response.status}: ${detail.slice(0, 300)}`);
      }

      const body = (await response.json()) as {
        rows?: Array<{
          keys: string[];
          clicks: number;
          impressions: number;
          ctr: number;
          position: number;
        }>;
      };
      const rows = body.rows ?? [];
      if (rows.length === 0) break;

      const records = rows.map((row) => ({
        organization_id: job.organization_id,
        site_id: job.site_id!,
        date: row.keys[0],
        query: row.keys[1] ?? null,
        page: row.keys[2] ?? null,
        clicks: Math.round(row.clicks ?? 0),
        impressions: Math.round(row.impressions ?? 0),
        ctr: row.ctr ?? null,
        position: row.position ?? null,
      }));

      for (let offset = 0; offset < records.length; offset += 500) {
        const { error } = await admin
          .from("search_console_daily")
          .upsert(records.slice(offset, offset + 500), {
            onConflict: "site_id,date,query,page",
          });
        if (error) throw error;
      }

      totalRows += rows.length;
      await admin.from("background_jobs").update({ items_processed: totalRows }).eq("id", job.id);

      if (rows.length < ROW_LIMIT) break;
      if (page === MAX_PAGES - 1) {
        throw new Error(`GSC import exceeded the ${MAX_PAGES * ROW_LIMIT} row safety limit`);
      }
      startRow += ROW_LIMIT;
    }

    const aggregateStart = computeWindow(28).startDate;
    const { data: aggregateRows, error: aggregateError } = await admin
      .from("search_console_daily")
      .select("clicks, impressions")
      .eq("organization_id", job.organization_id)
      .eq("site_id", job.site_id)
      .gte("date", aggregateStart);
    if (aggregateError) throw aggregateError;
    const totals = (aggregateRows ?? []).reduce(
      (result, row) => ({
        clicks: result.clicks + (row.clicks ?? 0),
        impressions: result.impressions + (row.impressions ?? 0),
      }),
      { clicks: 0, impressions: 0 },
    );

    const completedAt = new Date().toISOString();
    const { error: siteError } = await admin
      .from("sites")
      .update({
        monthly_clicks: totals.clicks,
        monthly_impressions: totals.impressions,
        last_synced_at: completedAt,
      })
      .eq("organization_id", job.organization_id)
      .eq("id", job.site_id);
    if (siteError) throw siteError;

    const { error: telemetryError } = await admin
      .from("integration_connections")
      .update({ last_synced_at: completedAt, last_error: null })
      .eq("organization_id", job.organization_id)
      .eq("site_id", job.site_id)
      .eq("provider", "gsc");
    if (telemetryError) throw telemetryError;

    return {
      rows: totalRows,
      clicks: totals.clicks,
      impressions: totals.impressions,
      startDate: window.startDate,
      endDate: window.endDate,
    };
  } catch (error) {
    const message = sanitizeGscError(error);
    await updateConnectionError(admin, job, message);
    throw new Error(message);
  }
}
