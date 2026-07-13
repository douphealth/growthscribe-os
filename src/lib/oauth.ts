import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";

export const GOOGLE_OAUTH_PROVIDER = "google" as const;

export function oauthRedirectUrl(origin: string) {
  return new URL("/dashboard", origin).toString();
}

export function googleOAuthOptions(origin: string) {
  return {
    provider: GOOGLE_OAUTH_PROVIDER,
    options: {
      redirectTo: oauthRedirectUrl(origin),
    },
  } as const;
}

export function isLovableHostedOrigin(origin: string) {
  return new URL(origin).hostname.endsWith(".lovable.app");
}

export async function signInWithGoogle(origin: string) {
  if (isLovableHostedOrigin(origin)) {
    const result = await lovable.auth.signInWithOAuth(GOOGLE_OAUTH_PROVIDER, {
      redirect_uri: oauthRedirectUrl(origin),
    });
    return { error: result.error };
  }

  const { error } = await supabase.auth.signInWithOAuth(googleOAuthOptions(origin));
  return { error };
}
