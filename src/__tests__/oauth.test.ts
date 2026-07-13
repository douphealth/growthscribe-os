import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { externalGoogleOAuthUrl, isLovableHostedOrigin, oauthRedirectUrl } from "@/lib/oauth";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("external-host OAuth", () => {
  it("returns users to the dashboard on the active production origin", () => {
    expect(oauthRedirectUrl("https://growthscribe-os.papalexios.workers.dev")).toBe(
      "https://growthscribe-os.papalexios.workers.dev/dashboard",
    );
    expect(oauthRedirectUrl("https://example.com/login")).toBe("https://example.com/dashboard");
  });

  it("builds a Lovable preview OAuth bridge for external deployments", () => {
    const url = new URL(externalGoogleOAuthUrl("fixed-state"));
    expect(url.origin).toBe("https://preview--growthscribe-os.lovable.app");
    expect(url.pathname).toBe("/~oauth/initiate");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://preview--growthscribe-os.lovable.app/dashboard",
    );
    expect(url.searchParams.get("state")).toBe("fixed-state");
  });

  it("uses the Lovable broker only on Lovable-hosted origins", () => {
    expect(isLovableHostedOrigin("https://growthscribe-os.lovable.app")).toBe(true);
    expect(isLovableHostedOrigin("https://growthscribe-os.papalexios.workers.dev")).toBe(false);
  });

  it("keeps hosting-specific OAuth details out of login and signup", () => {
    for (const route of ["src/routes/login.tsx", "src/routes/signup.tsx"]) {
      const code = source(route);
      expect(code).toContain("signInWithGoogle");
      expect(code).not.toContain("lovable.auth.signInWithOAuth");
      expect(code).not.toContain("~oauth/initiate");
    }
  });
});
