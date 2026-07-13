import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json, Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeWindow, enqueueGscPullJob } from "@/lib/gsc-import.server";

type SB = SupabaseClient<Database>;
async function assertMember(supabase: SB, userId: string, organizationId: string) {
  const { data, error } = await supabase
    .from("organization_members")
    .select("id")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Not a member of this organization");
}

const GSC_GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";

function gscHeaders(): HeadersInit {
  const lovable = process.env.LOVABLE_API_KEY;
  const gsc = process.env.GOOGLE_SEARCH_CONSOLE_API_KEY;
  if (!lovable) throw new Error("LOVABLE_API_KEY is not configured");
  if (!gsc)
    throw new Error("Google Search Console connector is not linked. Connect it from Integrations.");
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": gsc,
    "Content-Type": "application/json",
  };
}

async function gscFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${GSC_GATEWAY}${path}`, {
    ...init,
    headers: { ...gscHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GSC ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

export const listGscProperties = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { organizationId: string }) =>
    z.object({ organizationId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertMember(context.supabase, context.userId, data.organizationId);
    try {
      const json = (await gscFetch(`/webmasters/v3/sites`)) as {
        siteEntry?: { siteUrl: string; permissionLevel: string }[];
      };
      const entries = json.siteEntry ?? [];
      return {
        ok: true as const,
        properties: entries.map((e) => ({
          siteUrl: e.siteUrl,
          permissionLevel: e.permissionLevel,
        })),
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, properties: [] };
    }
  });

const gscInput = z.object({
  organizationId: z.string().uuid(),
  siteId: z.string().uuid(),
  property: z.string().trim().min(4).max(300),
});

export const saveGscProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => gscInput.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertMember(supabase, userId, data.organizationId);
    await supabase
      .from("integration_connections")
      .delete()
      .eq("organization_id", data.organizationId)
      .eq("site_id", data.siteId)
      .eq("provider", "gsc");
    const { error } = await supabase.from("integration_connections").insert({
      organization_id: data.organizationId,
      site_id: data.siteId,
      provider: "gsc",
      status: "connected",
      created_by: userId,
      config: { property: data.property } as Json,
    });
    if (error) throw error;
    await supabase
      .from("sites")
      .update({ gsc_property: data.property })
      .eq("id", data.siteId)
      .eq("organization_id", data.organizationId);
    await supabase.from("activities").insert({
      organization_id: data.organizationId,
      owner_id: userId,
      type: "integration.gsc.connected",
      title: "Search Console linked",
      description: data.property,
      link: "/integrations",
    });
    return { ok: true };
  });

const pullGscInput = z.object({
  organizationId: z.string().uuid(),
  siteId: z.string().uuid(),
  days: z.number().int().min(1).max(90).default(28),
});

export const pullSearchConsole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => pullGscInput.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertMember(supabase, userId, data.organizationId);

    const { data: connection, error: connectionError } = await supabase
      .from("integration_connections")
      .select("status, config")
      .eq("organization_id", data.organizationId)
      .eq("site_id", data.siteId)
      .eq("provider", "gsc")
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection || connection.status !== "connected") {
      throw new Error("Google Search Console is not connected for this site.");
    }
    const config = (connection.config ?? {}) as Record<string, unknown>;
    if (typeof config.property !== "string" || !config.property) {
      throw new Error("Save a GSC property URL first.");
    }

    const window = computeWindow(data.days);
    const result = await enqueueGscPullJob(supabase, {
      organizationId: data.organizationId,
      siteId: data.siteId,
      createdBy: userId,
      startDate: window.startDate,
      endDate: window.endDate,
      trigger: "manual",
    });
    return { ok: true as const, ...result };
  });

const ga4Input = z.object({
  organizationId: z.string().uuid(),
  siteId: z.string().uuid(),
  propertyId: z.string().trim().min(3).max(80),
});

export const saveGa4Property = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => ga4Input.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertMember(supabase, userId, data.organizationId);
    await supabase
      .from("integration_connections")
      .delete()
      .eq("organization_id", data.organizationId)
      .eq("site_id", data.siteId)
      .eq("provider", "ga4");
    const { error } = await supabase.from("integration_connections").insert({
      organization_id: data.organizationId,
      site_id: data.siteId,
      provider: "ga4",
      status: "connected",
      created_by: userId,
      config: { property_id: data.propertyId } as Json,
    });
    if (error) throw error;
    await supabase
      .from("sites")
      .update({ ga4_property_id: data.propertyId })
      .eq("id", data.siteId)
      .eq("organization_id", data.organizationId);
    await supabase.from("activities").insert({
      organization_id: data.organizationId,
      owner_id: userId,
      type: "integration.ga4.connected",
      title: "GA4 linked",
      description: data.propertyId,
      link: "/integrations",
    });
    return { ok: true };
  });
