// Phase 3 reconciliation marker: verifies tenancy, canonicalization, and queue-only operations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Portfolio Control Plane", () => {
  const migration = source("supabase/migrations/20260713190000_portfolio_control_plane.sql");
  const functions = source("src/lib/portfolio.functions.ts");
  const dashboard = source("src/components/dashboard/PortfolioControlPlane.tsx");

  it("keeps portfolio reads membership-scoped without a service-role bypass", () => {
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("m.user_id = auth.uid()");
    expect(migration).toContain("GRANT EXECUTE");
    expect(migration).not.toContain("SECURITY DEFINER");
    expect(functions).toContain("requireSupabaseAuth");
    expect(functions).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("deduplicates canonical domains only inside the portfolio projection", () => {
    expect(migration).toContain("PARTITION BY lower(");
    expect(migration).toContain("canonical_rank = 1");
    expect(migration).toContain("duplicatesSuppressed");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.sites/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.organizations/i);
  });

  it("anchors per-site comparisons to the latest available GSC date", () => {
    expect(migration).toContain("max(sc.date) AS latest_data_date");
    expect(migration).toContain("sb.latest_data_date - (p.window_days - 1)");
    expect(migration).toContain("current_date - sf.latest_data_date > 4");
  });

  it("bulk sync schedules only connected GSC integrations through the canonical queue", () => {
    expect(functions).toContain('.eq("provider", "gsc")');
    expect(functions).toContain('.eq("status", "connected")');
    expect(functions).toContain("enqueueGscPullJob");
    expect(functions).not.toContain("searchAnalytics/query");
    expect(functions).not.toContain('from("search_console_daily")');
  });

  it("ships operational filters and both portfolio and per-site controls", () => {
    expect(dashboard).toContain("Sync all GSC");
    expect(dashboard).toContain("Website operations matrix");
    expect(dashboard).toContain("stateFilter");
    expect(dashboard).toContain("handleSyncOne");
    expect(dashboard).toContain("openWorkspace");
  });
});
