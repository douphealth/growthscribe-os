import type { PortfolioSite } from "@/lib/portfolio.functions";

export type EvidenceState = "verified" | "configured" | "degraded" | "missing";
export type DecisionReadiness = "ready" | "limited" | "blocked";
export type ReliabilityDestination = "/sites" | "/integrations" | "/tasks" | "/approvals";

export type ReliabilityAction = {
  kind: "navigate" | "sync";
  destination: ReliabilityDestination;
  label: string;
};

export type SiteReliability = {
  score: number;
  readiness: DecisionReadiness;
  gscEvidence: EvidenceState;
  wordpressEvidence: EvidenceState;
  ga4Evidence: EvidenceState;
  reasons: string[];
  primaryAction: ReliabilityAction;
  priority: number;
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function ageHours(value: string | null, now: Date) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, (now.getTime() - parsed) / HOUR_MS) : Infinity;
}

function ageDays(value: string | null, now: Date) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(`${value}T00:00:00Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Number.isFinite(parsed) ? Math.max(0, (today - parsed) / DAY_MS) : Infinity;
}

/**
 * Deterministic evidence model for the control plane.
 *
 * "Connected" database rows are intentionally not treated as proof that a
 * provider is returning usable data. GSC can be verified from ingestion
 * telemetry already present in the portfolio snapshot. WordPress and GA4 are
 * reported as configured until equivalent freshness telemetry is available.
 */
export function assessSiteReliability(site: PortfolioSite, now = new Date()): SiteReliability {
  const reasons: string[] = [];
  const syncAgeHours = ageHours(site.gscLastSyncedAt, now);
  const dataAgeDays = ageDays(site.latestDataDate, now);

  let gscEvidence: EvidenceState;
  let score = 0;

  if (site.gscStatus !== "connected") {
    gscEvidence = "missing";
    reasons.push("Search Console is not connected");
  } else if (site.gscLastError) {
    gscEvidence = "degraded";
    score += 15;
    reasons.push("Search Console reported an ingestion error");
  } else if (!site.latestDataDate || !site.gscLastSyncedAt) {
    gscEvidence = "configured";
    score += 25;
    reasons.push("Search Console is configured but has no verified import");
  } else if (dataAgeDays > 4 || syncAgeHours > 36) {
    gscEvidence = "degraded";
    score += 35;
    reasons.push("Search Console evidence is outside the freshness SLA");
  } else {
    gscEvidence = "verified";
    score += 60;
  }

  if (site.failedJobs7d > 0) {
    reasons.push(
      `${site.failedJobs7d} production job${site.failedJobs7d === 1 ? "" : "s"} failed in 7 days`,
    );
  } else {
    score += 15;
  }

  const wordpressEvidence: EvidenceState = site.wordpressConnected ? "configured" : "missing";
  if (site.wordpressConnected) score += 10;
  else reasons.push("WordPress management is not configured");

  // The current portfolio RPC exposes a GA4 connection row, but no imported
  // metric date or API probe. Calling this verified would overstate evidence.
  const ga4Evidence: EvidenceState = site.ga4Connected ? "configured" : "missing";
  if (site.ga4Connected) {
    score += 5;
    reasons.push("GA4 property is saved; ingestion evidence is not available in this snapshot");
  } else {
    reasons.push("GA4 management data is not configured");
  }

  if (site.pendingApprovals === 0) score += 5;
  else
    reasons.push(
      `${site.pendingApprovals} approval${site.pendingApprovals === 1 ? "" : "s"} waiting`,
    );

  if (site.openTasks === 0) score += 5;

  const readiness: DecisionReadiness =
    gscEvidence === "missing" || Boolean(site.gscLastError)
      ? "blocked"
      : gscEvidence === "verified" && site.failedJobs7d === 0
        ? "ready"
        : "limited";

  let primaryAction: ReliabilityAction;
  if (site.gscStatus !== "connected" || site.gscLastError || site.failedJobs7d > 0) {
    primaryAction = { kind: "navigate", destination: "/integrations", label: "Repair data source" };
  } else if (gscEvidence !== "verified") {
    primaryAction = { kind: "sync", destination: "/integrations", label: "Refresh Search Console" };
  } else if (site.pendingApprovals > 0) {
    primaryAction = { kind: "navigate", destination: "/approvals", label: "Review approvals" };
  } else if (site.openTasks > 0) {
    primaryAction = { kind: "navigate", destination: "/tasks", label: "Open task queue" };
  } else if (!site.wordpressConnected || !site.ga4Connected) {
    primaryAction = { kind: "navigate", destination: "/integrations", label: "Complete coverage" };
  } else {
    primaryAction = { kind: "navigate", destination: "/sites", label: "Manage site" };
  }

  const priority =
    (readiness === "blocked" ? 300 : readiness === "limited" ? 200 : 100) +
    (100 - score) +
    site.failedJobs7d * 10 +
    site.pendingApprovals * 2 +
    Math.min(site.openTasks, 20);

  return {
    score: Math.max(0, Math.min(100, score)),
    readiness,
    gscEvidence,
    wordpressEvidence,
    ga4Evidence,
    reasons,
    primaryAction,
    priority,
  };
}

export function summarizeReliability(
  sites: PortfolioSite[],
  now = new Date(),
): { ready: number; limited: number; blocked: number; averageScore: number } {
  const assessments = sites.map((site) => assessSiteReliability(site, now));
  const total = assessments.reduce((sum, assessment) => sum + assessment.score, 0);
  return {
    ready: assessments.filter((assessment) => assessment.readiness === "ready").length,
    limited: assessments.filter((assessment) => assessment.readiness === "limited").length,
    blocked: assessments.filter((assessment) => assessment.readiness === "blocked").length,
    averageScore: assessments.length ? Math.round(total / assessments.length) : 0,
  };
}
