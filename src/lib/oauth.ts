import { lovable } from "@/integrations/lovable";

export const GOOGLE_OAUTH_PROVIDER = "google" as const;
export const LOVABLE_PREVIEW_ORIGIN = "https://preview--growthscribe-os.lovable.app";

export function oauthRedirectUrl(origin: string) {
  return new URL("/dashboard", origin).toString();
}

export function isLovableHostedOrigin(origin: string) {
  return new URL(origin).hostname.endsWith(".lovable.app");
}

export function externalGoogleOAuthUrl(state: string, previewOrigin = LOVABLE_PREVIEW_ORIGIN) {
  const url = new URL("/~oauth/initiate", previewOrigin);
  url.searchParams.set("provider", GOOGLE_OAUTH_PROVIDER);
  url.searchParams.set("redirect_uri", oauthRedirectUrl(previewOrigin));
  url.searchParams.set("state", state);
  return url.toString();
}

function oauthState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signInWithGoogle(origin: string) {
  if (isLovableHostedOrigin(origin)) {
    const result = await lovable.auth.signInWithOAuth(GOOGLE_OAUTH_PROVIDER, {
      redirect_uri: oauthRedirectUrl(origin),
    });
    return { error: result.error };
  }

  window.location.assign(externalGoogleOAuthUrl(oauthState()));
  return { error: null };
}
