import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("product truth contract", () => {
  const integrations = source("src/lib/integrations.functions.ts");
  const integrationUi = source("src/routes/_authenticated/integrations.tsx");
  const worker = source("src/lib/worker-jobs.server.ts");
  const aiLab = source("src/lib/ai-visibility.functions.ts");
  const aiLabUi = source("src/routes/_authenticated/ai-visibility.tsx");
  const landing = source("src/routes/index.tsx");

  it("records GA4 as configured without reporting a successful no-op import", () => {
    expect(integrations).toContain('verification_state: "configured"');
    expect(integrations).toContain("ingestion_enabled: false");
    expect(integrationUi).toContain("API ingestion is not verified yet");
    expect(worker).not.toContain("GA4 ingestion pending connector wiring");
    expect(worker).toContain("GA4 metric ingestion is disabled");
  });

  it("labels model scenarios honestly and does not impersonate Perplexity", () => {
    expect(aiLab).toContain('method: "model_response_simulation"');
    expect(aiLab).not.toContain('"perplexity"] as const');
    expect(aiLab).not.toContain("Do NOT add disclaimers");
    expect(aiLabUi).toContain("not live ChatGPT, Gemini, Perplexity");
    expect(aiLabUi).toContain("Legacy Gemini proxy (not Perplexity)");
  });

  it("keeps public claims within implemented evidence", () => {
    expect(landing).toContain("Verified GSC + Data Trust");
    expect(landing).not.toContain("Unified GSC + GA4");
    expect(landing).not.toContain("revenue, and rankings");
  });
});
