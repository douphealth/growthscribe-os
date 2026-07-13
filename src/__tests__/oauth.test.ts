import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  googleOAuthOptions,
  isGoogleSignInAvailable,
  isLovableHostedOrigin,
  oauthRedirectUrl,
} from "@/lib/oauth";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("external-host OAuth", () => {
  it("returns users to the dashboard on the active production origin", () => {
    expect(oauthRedirectUrl("https://growthscribe-os.papalexios.workers.dev")).toBe(
      "https://growthscribe-os.papalexios.workers.dev/dashboard",
    );
    expect(oauthRedirectUrl("https://example.com/login")).toBe("https://example.com/dashboard");
  });

  it("builds a Supabase Google OAuth request", () => {
    expect(googleOAuthOptions("https://growthscribe-os.papalexios.workers.dev")).toEqual({
      provider: "google",
      options: {
        redirectTo: "https://growthscribe-os.papalexios.workers.dev/dashboard",
      },
    });
  });

  it("uses the Lovable broker only on Lovable-hosted origins", () => {
    expect(isLovableHostedOrigin("https://growthscribe-os.lovable.app")).toBe(true);
    expect(isLovableHostedOrigin("https://growthscribe-os.papalexios.workers.dev")).toBe(false);
  });

  it("blocks external Google redirects until the provider is explicitly enabled", () => {
    const workerOrigin = "https://growthscribe-os.papalexios.workers.dev";
    expect(isGoogleSignInAvailable(workerOrigin, false)).toBe(false);
    expect(isGoogleSignInAvailable(workerOrigin, true)).toBe(true);
    expect(isGoogleSignInAvailable("https://growthscribe-os.lovable.app", false)).toBe(true);
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
