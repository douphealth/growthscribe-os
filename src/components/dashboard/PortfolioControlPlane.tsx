// Phase 3 reconciliation marker: ensures Lovable imports the complete control-plane module.
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  CircleGauge,
  ExternalLink,
  Globe2,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  getPortfolioControlPlane,
  syncPortfolioGsc,
  type PortfolioSite,
} from "@/lib/portfolio.functions";
import { pullSearchConsole } from "@/lib/integrations.functions";
import {
  assessSiteReliability,
  summarizeReliability,
  type DecisionReadiness,
  type EvidenceState,
} from "@/lib/portfolio-reliability";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const chartConfig = {
  clicks: { label: "Clicks", color: "var(--chart-1)" },
  impressions: { label: "Impressions", color: "var(--chart-2)" },
} satisfies ChartConfig;

const stateOrder: Record<PortfolioSite["operationalState"], number> = {
  critical: 0,
  stale: 1,
  attention: 2,
  healthy: 3,
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { notation: value >= 10_000 ? "compact" : "standard" }).format(
    value,
  );
}

function formatDate(value: string | null) {
  if (!value) return "No data";
  return format(new Date(`${value}T00:00:00Z`), "MMM d, yyyy");
}

function freshness(value: string | null) {
  if (!value) return "Never synced";
  return formatDistanceToNow(new Date(value), { addSuffix: true });
}

function EvidenceDot({ state, label }: { state: EvidenceState; label: string }) {
  const styles: Record<EvidenceState, string> = {
    verified: "text-emerald-700 dark:text-emerald-300",
    configured: "text-blue-700 dark:text-blue-300",
    degraded: "text-amber-700 dark:text-amber-300",
    missing: "text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${styles[state]}`}
      title={`${label}: ${state}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${state === "missing" ? "opacity-40" : ""}`}
      />
      {label}
    </span>
  );
}

function ReliabilityBadge({ readiness }: { readiness: DecisionReadiness }) {
  const styles: Record<DecisionReadiness, string> = {
    ready: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    limited: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    blocked: "border-destructive/20 bg-destructive/10 text-destructive",
  };
  return (
    <Badge variant="outline" className={styles[readiness]}>
      {readiness}
    </Badge>
  );
}

function Trend({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">No baseline</span>;
  const positive = value >= 0;
  return (
    <span
      className={
        positive
          ? "inline-flex items-center text-xs font-medium text-emerald-600"
          : "inline-flex items-center text-xs font-medium text-destructive"
      }
    >
      {positive ? (
        <ArrowUpRight className="mr-0.5 h-3.5 w-3.5" />
      ) : (
        <ArrowDownRight className="mr-0.5 h-3.5 w-3.5" />
      )}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  helper,
  accent = false,
}: {
  icon: typeof Globe2;
  label: string;
  value: string;
  helper: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <Card
      className={
        accent ? "border-primary/25 bg-gradient-to-br from-primary/8 via-card to-card" : ""
      }
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight font-display">{value}</p>
            <div className="mt-1 min-h-4 text-xs text-muted-foreground">{helper}</div>
          </div>
          <div className="rounded-xl border border-primary/10 bg-primary/10 p-2.5 text-primary">
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PortfolioControlPlane() {
  const { user } = useAuth();
  const { setCurrentOrgId } = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchPortfolio = useServerFn(getPortfolioControlPlane);
  const syncAll = useServerFn(syncPortfolioGsc);
  const syncOne = useServerFn(pullSearchConsole);
  const [days, setDays] = useState(28);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [sort, setSort] = useState("priority");
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingSite, setSyncingSite] = useState<string | null>(null);

  const portfolio = useQuery({
    queryKey: ["portfolio-control-plane", user?.id, days],
    enabled: Boolean(user),
    queryFn: () => fetchPortfolio({ data: { days } }),
    staleTime: 60_000,
    refetchInterval: (query) =>
      (query.state.data?.summary.activeJobs ?? 0) > 0 ? 15_000 : 120_000,
  });

  const assessments = useMemo(
    () =>
      new Map(
        (portfolio.data?.sites ?? []).map((site) => [site.siteId, assessSiteReliability(site)]),
      ),
    [portfolio.data?.sites],
  );

  const sites = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...(portfolio.data?.sites ?? [])]
      .filter((site) =>
        stateFilter === "all" ? true : assessments.get(site.siteId)?.readiness === stateFilter,
      )
      .filter((site) =>
        query
          ? [site.name, site.domain, site.organizationName].some((value) =>
              value.toLowerCase().includes(query),
            )
          : true,
      )
      .sort((a, b) => {
        if (sort === "clicks") return b.clicks - a.clicks;
        if (sort === "name") return a.domain.localeCompare(b.domain);
        if (sort === "freshness") {
          return (a.latestDataDate ?? "").localeCompare(b.latestDataDate ?? "");
        }
        return (
          (assessments.get(b.siteId)?.priority ?? 0) - (assessments.get(a.siteId)?.priority ?? 0) ||
          stateOrder[a.operationalState] - stateOrder[b.operationalState] ||
          b.clicks - a.clicks
        );
      });
  }, [assessments, portfolio.data?.sites, search, sort, stateFilter]);

  const prioritySites = useMemo(
    () =>
      (portfolio.data?.sites ?? [])
        .map((site) => ({ site, reliability: assessments.get(site.siteId)! }))
        .filter(
          ({ site, reliability }) =>
            reliability.readiness !== "ready" ||
            site.pendingApprovals > 0 ||
            site.openTasks > 0 ||
            !site.wordpressConnected ||
            !site.ga4Connected,
        )
        .sort((a, b) => b.reliability.priority - a.reliability.priority)
        .slice(0, 6),
    [assessments, portfolio.data?.sites],
  );

  const openWorkspace = (
    site: PortfolioSite,
    destination: "/sites" | "/integrations" | "/tasks" | "/approvals" = "/sites",
  ) => {
    setCurrentOrgId(site.organizationId);
    navigate({ to: destination });
  };

  const handleSyncOne = async (site: PortfolioSite) => {
    if (site.gscStatus !== "connected") {
      openWorkspace(site, "/integrations");
      return;
    }
    setSyncingSite(site.siteId);
    try {
      const result = await syncOne({
        data: { organizationId: site.organizationId, siteId: site.siteId, days },
      });
      toast.success(
        result.created ? `${site.domain} sync queued` : `${site.domain} sync already active`,
      );
      await queryClient.invalidateQueries({ queryKey: ["portfolio-control-plane"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not schedule the sync");
    } finally {
      setSyncingSite(null);
    }
  };

  const handlePriorityAction = (site: PortfolioSite) => {
    const action = assessments.get(site.siteId)?.primaryAction;
    if (action?.kind === "sync") {
      void handleSyncOne(site);
      return;
    }
    openWorkspace(site, action?.destination ?? "/sites");
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      const result = await syncAll({ data: { days } });
      if (result.failed > 0) {
        toast.warning(
          `${result.scheduled} syncs queued, ${result.reused} already active, ${result.failed} failed`,
        );
      } else {
        toast.success(`${result.scheduled} syncs queued · ${result.reused} already active`);
      }
      await queryClient.invalidateQueries({ queryKey: ["portfolio-control-plane"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Portfolio sync could not be scheduled");
    } finally {
      setSyncingAll(false);
    }
  };

  if (portfolio.isError) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Portfolio control plane unavailable</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {portfolio.error instanceof Error
              ? portfolio.error.message
              : "The portfolio snapshot could not be loaded."}
          </span>
          <Button variant="outline" size="sm" onClick={() => portfolio.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const summary = portfolio.data?.summary;
  const trend = portfolio.data?.trend ?? [];
  const reliabilitySummary = summarizeReliability(portfolio.data?.sites ?? []);

  return (
    <>
      <PageHeader
        eyebrow="Portfolio Control Plane"
        title="Website Operations Command Center"
        description="One live operating view across every organization you manage — search performance, integrations, pipeline health, approvals, and the next action for every website."
        actions={
          <>
            <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
              <SelectTrigger className="w-[112px]" aria-label="Reporting window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="28">Last 28 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => portfolio.refetch()}
              title="Refresh dashboard"
            >
              <RefreshCw className={portfolio.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </Button>
            <Button onClick={handleSyncAll} disabled={syncingAll || !summary?.connectedGsc}>
              {syncingAll ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Workflow className="mr-2 h-4 w-4" />
              )}
              Sync all GSC
            </Button>
          </>
        }
      />

      {portfolio.isLoading ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {[1, 2, 3, 4, 5].map((item) => (
              <div key={item} className="h-32 animate-pulse rounded-xl border bg-muted/40" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-xl border bg-muted/40" />
        </div>
      ) : summary ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              icon={Globe2}
              label="Managed portfolio"
              value={`${summary.managedSites} sites`}
              helper={`${summary.organizations} separate organizations${summary.duplicatesSuppressed ? ` · ${summary.duplicatesSuppressed} duplicate hidden` : ""}`}
              accent
            />
            <MetricCard
              icon={BarChart3}
              label={`Organic clicks · ${days}d`}
              value={formatNumber(summary.totalClicks)}
              helper={<Trend value={summary.clickGrowthPct} />}
            />
            <MetricCard
              icon={Sparkles}
              label="Impressions"
              value={formatNumber(summary.totalImpressions)}
              helper={`${summary.ctr?.toFixed(2) ?? "—"}% portfolio CTR`}
            />
            <MetricCard
              icon={CheckCircle2}
              label="Decision-ready data"
              value={`${reliabilitySummary.ready}/${summary.managedSites}`}
              helper={`${reliabilitySummary.averageScore}% average data trust`}
            />
            <MetricCard
              icon={Activity}
              label="Work in motion"
              value={String(summary.activeJobs)}
              helper={`${summary.pendingApprovals} pending approvals`}
            />
          </div>

          {reliabilitySummary.blocked + reliabilitySummary.limited > 0 && (
            <Alert className="border-amber-500/25 bg-amber-500/5">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertTitle>
                Evidence gate: {reliabilitySummary.blocked} blocked · {reliabilitySummary.limited}{" "}
                limited
              </AlertTitle>
              <AlertDescription>
                Portfolio decisions should use only sites marked ready. A saved provider ID is
                treated as configured, not verified, until fresh ingestion telemetry exists.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,1fr)]">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Portfolio search demand</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Daily GSC totals across canonical managed domains · through{" "}
                    {formatDate(summary.latestDataDate)}
                  </p>
                </div>
                <Badge variant="secondary">Verified GSC evidence</Badge>
              </CardHeader>
              <CardContent>
                {trend.length ? (
                  <ChartContainer config={chartConfig} className="h-[280px] w-full aspect-auto">
                    <AreaChart data={trend} margin={{ left: 0, right: 8, top: 8 }}>
                      <defs>
                        <linearGradient id="fillImpressions" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="5%"
                            stopColor="var(--color-impressions)"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--color-impressions)"
                            stopOpacity={0.02}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        minTickGap={28}
                        tickFormatter={(value) => format(new Date(`${value}T00:00:00Z`), "MMM d")}
                      />
                      <YAxis
                        yAxisId="impressions"
                        tickLine={false}
                        axisLine={false}
                        width={48}
                        tickFormatter={formatNumber}
                      />
                      <YAxis
                        yAxisId="clicks"
                        orientation="right"
                        tickLine={false}
                        axisLine={false}
                        width={38}
                        tickFormatter={formatNumber}
                      />
                      <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                      <Area
                        yAxisId="impressions"
                        type="monotone"
                        dataKey="impressions"
                        stroke="var(--color-impressions)"
                        fill="url(#fillImpressions)"
                        strokeWidth={2}
                      />
                      <Area
                        yAxisId="clicks"
                        type="monotone"
                        dataKey="clicks"
                        stroke="var(--color-clicks)"
                        fill="transparent"
                        strokeWidth={2.5}
                      />
                    </AreaChart>
                  </ChartContainer>
                ) : (
                  <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                    Search Console data will appear after the first portfolio sync.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4" /> Priority queue
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Highest-impact operational actions across the portfolio.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {prioritySites.length ? (
                  prioritySites.map(({ site, reliability }) => (
                    <div key={site.siteId} className="rounded-lg border bg-muted/20 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <ReliabilityBadge readiness={reliability.readiness} />
                            <span className="text-[11px] font-medium text-muted-foreground">
                              Trust {reliability.score}/100
                            </span>
                          </div>
                          <p className="mt-2 truncate text-sm font-semibold">{site.domain}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {reliability.primaryAction.label}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handlePriorityAction(site)}
                          disabled={syncingSite === site.siteId}
                        >
                          {syncingSite === site.siteId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ArrowRight className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed p-8 text-center">
                    <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
                    <p className="mt-3 text-sm font-medium">Portfolio is operating normally</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      No urgent pipeline or workflow actions.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
                <div>
                  <CardTitle className="text-base">Website operations matrix</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Real-time management layer across organizations. Data remains isolated at
                    source.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative sm:w-64">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search site or organization"
                      className="pl-9"
                    />
                  </div>
                  <Select value={stateFilter} onValueChange={setStateFilter}>
                    <SelectTrigger className="sm:w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All evidence</SelectItem>
                      <SelectItem value="blocked">Blocked</SelectItem>
                      <SelectItem value="limited">Limited</SelectItem>
                      <SelectItem value="ready">Ready</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sort} onValueChange={setSort}>
                    <SelectTrigger className="sm:w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="priority">Priority</SelectItem>
                      <SelectItem value="clicks">Clicks</SelectItem>
                      <SelectItem value="freshness">Freshness</SelectItem>
                      <SelectItem value="name">Domain</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Website / organization</TableHead>
                    <TableHead>Trust / state</TableHead>
                    <TableHead>Provider evidence</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Impressions</TableHead>
                    <TableHead className="text-right">CTR / Position</TableHead>
                    <TableHead>Data freshness</TableHead>
                    <TableHead>Work</TableHead>
                    <TableHead className="pr-6 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((site) => {
                    const reliability = assessments.get(site.siteId)!;
                    return (
                      <TableRow key={site.siteId}>
                        <TableCell className="pl-6 py-4">
                          <div className="min-w-[190px]">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold">{site.domain}</span>
                              <a
                                href={site.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-primary"
                                title="Open website"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            </div>
                            <p className="mt-1 max-w-[220px] truncate text-[11px] text-muted-foreground">
                              {site.organizationName}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <ReliabilityBadge readiness={reliability.readiness} />
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            {reliability.score}/100 · {site.operationalState}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-[150px] flex-wrap gap-x-2 gap-y-1">
                            <EvidenceDot state={reliability.gscEvidence} label="GSC" />
                            <EvidenceDot state={reliability.wordpressEvidence} label="WP" />
                            <EvidenceDot state={reliability.ga4Evidence} label="GA4" />
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <p className="font-semibold tabular-nums">{formatNumber(site.clicks)}</p>
                          <Trend value={site.clickGrowthPct} />
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatNumber(site.impressions)}
                        </TableCell>
                        <TableCell className="text-right">
                          <p className="font-medium tabular-nums">{site.ctr?.toFixed(2) ?? "—"}%</p>
                          <p className="text-[11px] text-muted-foreground">
                            Pos. {site.averagePosition?.toFixed(1) ?? "—"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="min-w-[130px]">
                            <p className="text-xs font-medium">{formatDate(site.latestDataDate)}</p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              Synced {freshness(site.gscLastSyncedAt)}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="min-w-[110px] text-xs">
                            <p>{site.openTasks} tasks</p>
                            <p className="text-muted-foreground">
                              {site.pendingApprovals} approvals · {site.activeJobs} jobs
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSyncOne(site)}
                              disabled={syncingSite === site.siteId}
                            >
                              {syncingSite === site.siteId ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                              <span className="sr-only">Sync {site.domain}</span>
                            </Button>
                            <Button size="sm" onClick={() => openWorkspace(site)}>
                              Manage <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {sites.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
                        No websites match the current filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-primary/15">
            <CardContent className="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <CircleGauge className="h-4 w-4 text-primary" /> Portfolio data contract
                </div>
                <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  Performance windows are anchored to each site's latest available GSC date, so
                  normal reporting lag does not distort comparisons. Portfolio charts use actual
                  calendar dates. “Verified” requires fresh imported evidence; WordPress and GA4
                  remain “configured” until their own ingestion telemetry is available. Access is
                  membership-scoped and every action preserves the site's organization boundary.
                </p>
              </div>
              <div className="min-w-56">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span>Portfolio data trust</span>
                  <span className="font-semibold">{reliabilitySummary.averageScore}/100</span>
                </div>
                <Progress value={reliabilitySummary.averageScore} />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
