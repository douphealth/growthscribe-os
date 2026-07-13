import { describe, expect, it } from "vitest";
import { assessSiteReliability, summarizeReliability } from "@/lib/portfolio-reliability";
import type { PortfolioSite } from "@/lib/portfolio.functions";

const now = new Date("2026-07-13T12:00:00Z");

function site(overrides: Partial<PortfolioSite> = {}): PortfolioSite {
  return {
    siteId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    organizationName: "Test",
    role: "owner",
    name: "Example",
    url: "https://example.com",
    domain: "example.com",
    siteStatus: "connected",
    operationalState: "healthy",
    alertCount: 0,
    healthScore: null,
    authorityScore: null,
    totalPosts: null,
    gscStatus: "connected",
    gscProperty: "sc-domain:example.com",
    gscLastSyncedAt: "2026-07-13T08:00:00Z",
    gscLastError: null,
    wordpressConnected: true,
    ga4Connected: true,
    latestDataDate: "2026-07-10",
    clicks: 10,
    impressions: 100,
    clicks7d: 4,
    impressions7d: 40,
    clickGrowthPct: 10,
    ctr: 10,
    averagePosition: 8,
    openTasks: 0,
    pendingApprovals: 0,
    activeJobs: 0,
    failedJobs7d: 0,
    latestGscJobStatus: "succeeded",
    latestGscJobFinishedAt: "2026-07-13T08:00:00Z",
    ...overrides,
  };
}

describe("portfolio reliability", () => {
  it("marks fresh GSC evidence ready without pretending GA4 is verified", () => {
    const result = assessSiteReliability(site(), now);
    expect(result.readiness).toBe("ready");
    expect(result.gscEvidence).toBe("verified");
    expect(result.ga4Evidence).toBe("configured");
    expect(result.score).toBe(90);
    expect(result.reasons).toContain(
      "GA4 property is saved; ingestion evidence is not available in this snapshot",
    );
  });

  it("blocks decisions when Search Console is missing", () => {
    const result = assessSiteReliability(
      site({ gscStatus: "missing", gscLastSyncedAt: null, latestDataDate: null }),
      now,
    );
    expect(result.readiness).toBe("blocked");
    expect(result.gscEvidence).toBe("missing");
    expect(result.primaryAction.destination).toBe("/integrations");
  });

  it("treats stale imports and production failures as limited evidence", () => {
    const result = assessSiteReliability(
      site({ latestDataDate: "2026-06-30", failedJobs7d: 2 }),
      now,
    );
    expect(result.readiness).toBe("limited");
    expect(result.gscEvidence).toBe("degraded");
    expect(result.primaryAction.label).toBe("Repair data source");
    expect(result.score).toBeLessThan(70);
  });

  it("summarizes the portfolio deterministically", () => {
    const result = summarizeReliability(
      [site(), site({ gscLastError: "token expired" }), site({ latestDataDate: "2026-07-01" })],
      now,
    );
    expect(result).toMatchObject({ ready: 1, limited: 1, blocked: 1 });
    expect(result.averageScore).toBeGreaterThan(0);
  });
});
