import { describe, expect, it } from "vitest";
import { growthPriorityScore, validateContentRefresh } from "@/lib/autonomous-growth.server";

function article(extra = "") {
  const body = Array.from(
    { length: 180 },
    (_, i) => `Useful evidence sentence ${i} explains the topic clearly.`,
  ).join(" ");
  return `<p>${body}</p><h2>What matters</h2><p>${body}</p><h2>How to decide</h2><ul><li>Compare the options</li><li>Check the constraints</li></ul>${extra}`;
}

describe("Hermes autonomous growth", () => {
  it("prioritizes pages with demand and striking-distance rankings", () => {
    const strong = growthPriorityScore({
      impressions: 2500,
      clicks: 25,
      averagePosition: 8,
      seoScore: 60,
      aeoScore: 55,
      geoScore: 50,
      freshnessScore: 30,
      commercialIntent: true,
    });
    const weak = growthPriorityScore({
      impressions: 12,
      clicks: 2,
      averagePosition: 2,
      seoScore: 90,
      aeoScore: 90,
      geoScore: 90,
      freshnessScore: 90,
    });
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(100);
  });

  it("rejects large content loss and fabricated first-person testing claims", () => {
    const before = article();
    const result = validateContentRefresh({
      url: "https://example.com/guide/",
      beforeTitle: "A Complete Practical Guide for Readers",
      beforeExcerpt:
        "A practical explanation that helps readers understand the topic and make a better decision using the evidence already on the page.",
      beforeHtml: before,
      nextTitle: "A Complete Practical Guide for Readers",
      nextExcerpt:
        "A practical explanation that helps readers understand the topic and make a better decision using the evidence already on the page.",
      nextHtml: "<p>We tested this personally and it is better.</p>",
      minimumQualityScore: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/shrank|testing claim/i);
  });

  it("rejects newly introduced percentage claims", () => {
    const before = article();
    const result = validateContentRefresh({
      url: "https://example.com/guide/",
      beforeTitle: "A Complete Practical Guide for Readers",
      beforeExcerpt:
        "A practical explanation that helps readers understand the topic and make a better decision using the evidence already on the page.",
      beforeHtml: before,
      nextTitle: "A Complete Practical Guide for Readers",
      nextExcerpt:
        "A practical explanation that helps readers understand the topic and make a better decision using the evidence already on the page.",
      nextHtml: article("<p>This is 97% more effective.</p>"),
      minimumQualityScore: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("new percentage claim detected");
  });
});
