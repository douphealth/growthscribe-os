import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { computeWindow, enqueueGscPullJob, sanitizeGscError } from "@/lib/gsc-import.server";

const operationalState = z.enum(["healthy", "attention", "stale", "critical"]);

const portfolioSiteSchema = z.object({
  siteId: z.string().uuid(),
  organizationId: z.string().uuid(),
  organizationName: z.string(),
  role: z.string(),
  name: z.string(),
  url: z.string(),
  domain: z.string(),
  siteStatus: z.string(),
  operationalState,
  alertCount: z.coerce.number(),
  healthScore: z.coerce.number().nullable(),
  authorityScore: z.coerce.number().nullable(),
  totalPosts: z.coerce.number().nullable(),
  gscStatus: z.string(),
  gscProperty: z.string().nullable(),
  gscLastSyncedAt: z.string().nullable(),
  gscLastError: z.string().nullable(),
  wordpressConnected: z.boolean(),
  ga4Connected: z.boolean(),
  latestDataDate: z.string().nullable(),
  clicks: z.coerce.number(),
  impressions: z.coerce.number(),
  clicks7d: z.coerce.number(),
  impressions7d: z.coerce.number(),
  clickGrowthPct: z.coerce.number().nullable(),
  ctr: z.coerce.number().nullable(),
  averagePosition: z.coerce.number().nullable(),
  openTasks: z.coerce.number(),
  pendingApprovals: z.coerce.number(),
  activeJobs: z.coerce.number(),
  failedJobs7d: z.coerce.number(),
  latestGscJobStatus: z.string().nullable(),
  latestGscJobFinishedAt: z.string().nullable(),
});

const portfolioSnapshotSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.coerce.number(),
  summary: z.object({
    organizations: z.coerce.number(),
    managedSites: z.coerce.number(),
    connectedGsc: z.coerce.number(),
    healthySites: z.coerce.number(),
    sitesNeedingAttention: z.coerce.number(),
    totalClicks: z.coerce.number(),
    totalImpressions: z.coerce.number(),
    ctr: z.coerce.number().nullable(),
    clickGrowthPct: z.coerce.number().nullable(),
    activeJobs: z.coerce.number(),
    pendingApprovals: z.coerce.number(),
    oldestDataDate: z.string().nullable(),
    latestDataDate: z.string().nullable(),
    duplicatesSuppressed: z.coerce.number(),
  }),
  sites: z.array(portfolioSiteSchema),
  trend: z.array(
    z.object({
      date: z.string(),
      clicks: z.coerce.number(),
      impressions: z.coerce.number(),
    }),
  ),
});

export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
export type PortfolioSite = z.infer<typeof portfolioSiteSchema>;

const portfolioInput = z.object({
  days: z.number().int().min(7).max(90).default(28),
});

export const getPortfolioControlPlane = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(portfolioInput)
  .handler(async ({ data, context }) => {
    const { data: snapshot, error } = await context.supabase.rpc("get_portfolio_control_plane", {
      p_window_days: data.days,
    });
    if (error) throw error;
    return portfolioSnapshotSchema.parse(snapshot);
  });

export const syncPortfolioGsc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(portfolioInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: memberships, error: membershipError } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", userId);
    if (membershipError) throw membershipError;

    const organizationIds = (memberships ?? []).map((membership) => membership.organization_id);
    if (organizationIds.length === 0) {
      return { scheduled: 0, reused: 0, failed: 0, jobs: [] };
    }

    const { data: connections, error: connectionError } = await supabase
      .from("integration_connections")
      .select("organization_id, site_id")
      .in("organization_id", organizationIds)
      .eq("provider", "gsc")
      .eq("status", "connected")
      .not("site_id", "is", null);
    if (connectionError) throw connectionError;

    const window = computeWindow(data.days);
    type SyncResult = {
      siteId: string;
      organizationId: string;
      jobId?: string;
      created?: boolean;
      error?: string;
    };

    const jobs = await Promise.all(
      (connections ?? []).flatMap((connection): Array<Promise<SyncResult>> => {
        if (!connection.site_id) return [];
        const siteId = connection.site_id;
        return [
          enqueueGscPullJob(supabase, {
            organizationId: connection.organization_id,
            siteId,
            createdBy: userId,
            startDate: window.startDate,
            endDate: window.endDate,
            trigger: "manual",
          })
            .then((result) => ({
              siteId,
              organizationId: connection.organization_id,
              jobId: result.jobId,
              created: result.created,
            }))
            .catch((error) => ({
              siteId,
              organizationId: connection.organization_id,
              error: sanitizeGscError(error),
            })),
        ];
      }),
    );

    return {
      scheduled: jobs.filter((job) => job.created).length,
      reused: jobs.filter((job) => job.jobId && !job.created).length,
      failed: jobs.filter((job) => job.error).length,
      jobs,
      window,
    };
  });
