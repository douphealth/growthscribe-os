import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computeWindow,
  gscConnectionLabel,
  gscDisableReason,
  sanitizeGscError,
} from "@/lib/gsc-import.server";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("GSC Phase 2 pipeline", () => {
  it("computes deterministic UTC import windows and clamps unsafe ranges", () => {
    expect(computeWindow(28, new Date("2026-07-13T23:30:00Z"))).toEqual({
      startDate: "2026-06-15",
      endDate: "2026-07-13",
      days: 28,
    });
    expect(computeWindow(999, new Date("2026-07-13T00:00:00Z")).days).toBe(90);
    expect(computeWindow(0, new Date("2026-07-13T00:00:00Z")).days).toBe(1);
  });

  it("sanitizes bearer tokens, connector keys, and JWT-shaped values", () => {
    const message = sanitizeGscError(
      "Bearer secret-token X-Connection-Api-Key: abc123 eyJhbGciOiJIUzI1NiJ9.payload.signature",
    );
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("recognizes the duplicate-sync disable reason", () => {
    expect(gscDisableReason({ disabled_reason: "duplicate_gsc_sync" })).toBe("duplicate_gsc_sync");
    expect(gscDisableReason({})).toBeNull();
  });

  it("suppresses reconnect for the intentionally revoked duplicate", () => {
    expect(gscConnectionLabel("revoked", "duplicate_gsc_sync")).toEqual({
      label: "Duplicate GSC sync disabled",
      showReconnect: false,
    });
    expect(gscConnectionLabel("error", null).showReconnect).toBe(true);
  });

  it("keeps manual sync enqueue-only", () => {
    const code = source("src/lib/integrations.functions.ts");
    const manual = code.slice(
      code.indexOf("export const pullSearchConsole"),
      code.indexOf("const ga4Input"),
    );
    expect(manual).toContain("enqueueGscPullJob");
    expect(manual).not.toContain('from("search_console_daily")');
    expect(manual).not.toContain("searchAnalytics/query");
  });

  it("keeps the GSC cron route enqueue-only", () => {
    const code = source("src/routes/api/public/cron/gsc-pull.ts");
    expect(code).toContain("enqueueGscPullJob");
    expect(code).not.toContain("searchAnalytics/query");
    expect(code).not.toContain('from("search_console_daily")');
  });

  it("keeps the worker dispatcher delegated to the canonical importer", () => {
    const code = source("src/lib/worker-jobs.server.ts");
    const dispatcher = source("src/routes/api/public/cron/worker.ts");
    const genericEnqueue = source("src/lib/jobs.functions.ts");
    expect(code).toContain("export const runGscImport = runGscImportJob");
    expect(code).not.toContain("google_search_console/webmasters/v3/sites");
    expect(dispatcher).not.toContain('case "gsc_import"');
    expect(genericEnqueue).not.toContain('"gsc_import"');
  });

  it("ships database-level deduplication and atomic queue claiming", () => {
    const indexes = source("supabase/migrations/20260713083553_gsc_pull_pipeline.sql");
    const claiming = source("supabase/migrations/20260713084442_claim_jobs_hotfix.sql");
    expect(indexes).toContain("uq_gsc_pull_active");
    expect(indexes).toContain("uq_search_console_daily_natural");
    expect(indexes).toContain("NULLS NOT DISTINCT");
    expect(claiming).toContain("FOR UPDATE OF j SKIP LOCKED");
    expect(claiming).toContain("p_max_running_gsc");
  });
});
