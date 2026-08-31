// Server-only Hermes autonomous growth orchestration.
// The design is deliberately evidence-first: diagnostics and proposals are fully
// autonomous, while live writes require an explicit per-site canary/autopilot policy.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { callLovableAIStructured } from "./ai-gateway";
import { scoreContent } from "./content-scoring";
import { fetchWpPost, getWpConnection, updateWpPost } from "./wordpress.server";

type Admin = SupabaseClient<Database>;
// New autonomy tables are introduced by a migration in this branch and are not
// in generated DB types until the migration is applied and types regenerated.
// Keep the unsafe cast local to this server-only module.
type DB = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type CandidateSignals = {
  impressions: number;
  clicks: number;
  averagePosition: number | null;
  seoScore: number | null;
  aeoScore: number | null;
  geoScore: number | null;
  freshnessScore: number | null;
  commercialIntent?: boolean;
};

export function growthPriorityScore(s: CandidateSignals): number {
  const impressions = Math.min(30, Math.log10(Math.max(1, s.impressions)) * 10);
  const pos = s.averagePosition ?? 100;
  const positionOpportunity =
    pos >= 4 && pos <= 20 ? 30 - Math.abs(pos - 9) * 1.5 : pos < 4 ? 8 : 2;
  const ctr = s.impressions > 0 ? s.clicks / s.impressions : 0;
  const expectedCtr = pos <= 3 ? 0.08 : pos <= 10 ? 0.035 : pos <= 20 ? 0.015 : 0.005;
  const ctrGap = Math.max(0, expectedCtr - ctr) * 400;
  const qualityGap =
    (100 - (s.seoScore ?? 60) + (100 - (s.aeoScore ?? 60)) + (100 - (s.geoScore ?? 60))) / 15;
  const stale = Math.max(0, 70 - (s.freshnessScore ?? 50)) / 5;
  const revenue = s.commercialIntent ? 8 : 0;
  return (
    Math.round(
      Math.max(
        0,
        Math.min(100, impressions + positionOpportunity + ctrGap + qualityGap + stale + revenue),
      ) * 10,
    ) / 10
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(html: string): number {
  const t = stripHtml(html);
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

export type RefreshValidation = {
  ok: boolean;
  reasons: string[];
  beforeScore: number;
  afterScore: number;
  beforeWords: number;
  afterWords: number;
};

export function validateContentRefresh(input: {
  url: string;
  beforeTitle: string;
  beforeExcerpt: string;
  beforeHtml: string;
  nextTitle: string;
  nextExcerpt: string;
  nextHtml: string;
  minimumQualityScore: number;
}): RefreshValidation {
  const reasons: string[] = [];
  const beforeWords = wordCount(input.beforeHtml);
  const afterWords = wordCount(input.nextHtml);
  if (!input.nextTitle.trim()) reasons.push("empty title");
  if (!input.nextHtml.trim()) reasons.push("empty content");
  if (beforeWords >= 300 && afterWords < Math.floor(beforeWords * 0.9)) {
    reasons.push("content shrank by more than 10%");
  }
  if (/\b(?:todo|tbd|lorem ipsum|placeholder)\b/i.test(input.nextHtml))
    reasons.push("placeholder text detected");
  if (/\bas an ai\b/i.test(input.nextHtml)) reasons.push("AI self-reference detected");
  if (
    /<script\b|<iframe\b/i.test(input.nextHtml) &&
    !/<script\b|<iframe\b/i.test(input.beforeHtml)
  ) {
    reasons.push("new executable/embed markup detected");
  }
  const testingClaim =
    /\b(?:i|we|our team)\s+(?:personally\s+)?(?:tested|reviewed hands-on|used for|bought)\b/i;
  if (testingClaim.test(input.nextHtml) && !testingClaim.test(input.beforeHtml)) {
    reasons.push("new first-person testing claim detected");
  }
  const newNumericClaims = (input.nextHtml.match(/\b\d+(?:\.\d+)?%\b/g) ?? []).filter(
    (claim) => !input.beforeHtml.includes(claim),
  );
  if (newNumericClaims.length > 0) reasons.push("new percentage claim detected");

  const before = scoreContent({
    title: input.beforeTitle,
    excerpt: input.beforeExcerpt,
    contentHtml: input.beforeHtml,
    contentText: stripHtml(input.beforeHtml),
    wordCount: beforeWords,
    url: input.url,
  });
  const after = scoreContent({
    title: input.nextTitle,
    excerpt: input.nextExcerpt,
    contentHtml: input.nextHtml,
    contentText: stripHtml(input.nextHtml),
    wordCount: afterWords,
    url: input.url,
  });
  const beforeScore = Math.round((before.seo_score + before.aeo_score + before.geo_score) / 3);
  const afterScore = Math.round((after.seo_score + after.aeo_score + after.geo_score) / 3);
  if (afterScore < beforeScore)
    reasons.push(`quality score regressed ${beforeScore} -> ${afterScore}`);
  if (afterScore < input.minimumQualityScore)
    reasons.push(`quality score ${afterScore} below floor ${input.minimumQualityScore}`);
  return { ok: reasons.length === 0, reasons, beforeScore, afterScore, beforeWords, afterWords };
}

async function enqueueUnique(
  admin: Admin,
  row: {
    organization_id: string;
    site_id: string;
    created_by: string;
    job_type: string;
    payload?: Record<string, unknown>;
    priority?: number;
    idempotency_key: string;
  },
) {
  const db = admin as DB;
  const { data: existing } = await db
    .from("background_jobs")
    .select("id,status")
    .eq("idempotency_key", row.idempotency_key)
    .in("status", ["queued", "running", "succeeded"])
    .maybeSingle();
  if (existing) return { id: existing.id, created: false };
  const { data, error } = await db
    .from("background_jobs")
    .insert({ ...row, payload: row.payload ?? {}, status: "queued", priority: row.priority ?? 0 })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, created: true };
}

function ymd(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function runAutonomyPortfolio(
  admin: Admin,
  job: {
    id: string;
    organization_id: string;
    site_id: string | null;
    created_by: string;
  },
) {
  if (!job.site_id) throw new Error("autonomy.portfolio requires site_id");
  const db = admin as DB;
  const { data: policy, error: policyError } = await db
    .from("autonomy_policies")
    .select("*")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .maybeSingle();
  if (policyError) throw policyError;
  if (!policy || !policy.enabled || policy.kill_switch) {
    return {
      blocked: true,
      reason: !policy ? "policy_missing" : policy.kill_switch ? "kill_switch" : "disabled",
    };
  }

  const { data: run, error: runError } = await db
    .from("autonomy_runs")
    .insert({
      organization_id: job.organization_id,
      site_id: job.site_id,
      mode: policy.mode,
      status: "running",
    })
    .select("id")
    .single();
  if (runError) throw runError;

  const dateKey = ymd();
  const diagnostics = [
    ["wordpress.sync", 40],
    ["gsc.pull", 50],
    ["crawl.site", 30],
    ["technical.scan", 30],
    ["vitals.refresh", 20],
  ] as const;
  const queued: string[] = [];
  for (const [jobType, priority] of diagnostics) {
    const r = await enqueueUnique(admin, {
      organization_id: job.organization_id,
      site_id: job.site_id,
      created_by: job.created_by,
      job_type: jobType,
      payload: jobType === "gsc.pull" ? { days: 28, trigger: "cron" } : { source: "autonomy" },
      priority,
      idempotency_key: `hermes:${job.site_id}:${dateKey}:${jobType}`,
    });
    if (r.created) queued.push(jobType);
  }

  const { data: posts, error: postsError } = await db
    .from("wordpress_posts")
    .select(
      "id,url,title,excerpt,content_html,seo_score,aeo_score,geo_score,freshness_score,recommended_action,status",
    )
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .eq("status", "publish")
    .limit(500);
  if (postsError) throw postsError;
  const { data: gscRows, error: gscError } = await db
    .from("search_console_daily")
    .select("page,query,clicks,impressions,position,date")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .gte("date", daysAgo(28))
    .limit(20000);
  if (gscError) throw gscError;

  const byPage = new Map<
    string,
    { clicks: number; impressions: number; weightedPos: number; queries: Map<string, number> }
  >();
  for (const r of gscRows ?? []) {
    if (!r.page) continue;
    const a = byPage.get(r.page) ?? {
      clicks: 0,
      impressions: 0,
      weightedPos: 0,
      queries: new Map<string, number>(),
    };
    const imp = Number(r.impressions ?? 0);
    a.clicks += Number(r.clicks ?? 0);
    a.impressions += imp;
    a.weightedPos += Number(r.position ?? 0) * imp;
    if (r.query) a.queries.set(r.query, (a.queries.get(r.query) ?? 0) + imp);
    byPage.set(r.page, a);
  }

  const candidates = (posts ?? [])
    .filter((p: DB) => p.url && p.content_html)
    .map((p: DB) => {
      const g = byPage.get(p.url) ?? {
        clicks: 0,
        impressions: 0,
        weightedPos: 0,
        queries: new Map<string, number>(),
      };
      const avgPos = g.impressions ? g.weightedPos / g.impressions : null;
      const title = String(p.title ?? "").toLowerCase();
      const commercial =
        /\b(best|review|vs|comparison|buy|price|deal|top|software|tool|shoe|watch)\b/.test(title);
      const score = growthPriorityScore({
        impressions: g.impressions,
        clicks: g.clicks,
        averagePosition: avgPos,
        seoScore: p.seo_score,
        aeoScore: p.aeo_score,
        geoScore: p.geo_score,
        freshnessScore: p.freshness_score,
        commercialIntent: commercial,
      });
      const queries = Array.from(g.queries.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([q]) => q);
      return { p, g, avgPos, score, queries, commercial };
    })
    .filter((c: DB) => c.g.impressions >= 20)
    .sort((a: DB, b: DB) => b.score - a.score);

  const top = candidates[0] ?? null;
  let actionId: string | null = null;
  if (top) {
    const { data: action, error: actionError } = await db
      .from("autonomy_actions")
      .insert({
        run_id: run.id,
        organization_id: job.organization_id,
        site_id: job.site_id,
        post_id: top.p.id,
        action_type: "content_refresh",
        risk: "low",
        status: "proposed",
        priority_score: top.score,
        confidence: top.g.impressions >= 100 ? 0.9 : 0.75,
        rationale:
          "Existing URL with measurable GSC demand and an optimization gap; preserve URL/equity and improve intent satisfaction.",
        evidence: {
          clicks28d: top.g.clicks,
          impressions28d: top.g.impressions,
          averagePosition28d: top.avgPos,
          topQueries: top.queries,
          seoScore: top.p.seo_score,
          aeoScore: top.p.aeo_score,
          geoScore: top.p.geo_score,
          freshnessScore: top.p.freshness_score,
        },
        before_snapshot: {
          url: top.p.url,
          title: top.p.title ?? "",
          excerpt: top.p.excerpt ?? "",
          contentHtml: top.p.content_html,
        },
      })
      .select("id")
      .single();
    if (actionError) throw actionError;
    actionId = action.id;
    await enqueueUnique(admin, {
      organization_id: job.organization_id,
      site_id: job.site_id,
      created_by: job.created_by,
      job_type: "autonomy.content.propose",
      payload: { actionId },
      priority: 60,
      idempotency_key: `hermes:${job.site_id}:${dateKey}:content-propose:${top.p.id}`,
    });
  }

  if (
    policy.social_provider &&
    Array.isArray(policy.social_networks) &&
    policy.social_networks.length > 0
  ) {
    await enqueueUnique(admin, {
      organization_id: job.organization_id,
      site_id: job.site_id,
      created_by: job.created_by,
      job_type: "social.plan",
      payload: { runId: run.id, preferredPostId: top?.p.id ?? null },
      priority: 20,
      idempotency_key: `hermes:${job.site_id}:${dateKey}:social-plan`,
    });
  }

  const decisions = {
    queuedDiagnostics: queued,
    contentActionId: actionId,
    topPriority: top?.score ?? null,
  };
  await db
    .from("autonomy_runs")
    .update({
      status: "succeeded",
      decisions,
      result: { candidateCount: candidates.length },
      finished_at: new Date().toISOString(),
    })
    .eq("id", run.id);
  return { runId: run.id, ...decisions, candidateCount: candidates.length };
}

type RefreshProposal = {
  title: string;
  excerpt: string;
  content_html: string;
  summary: string;
};

export async function runAutonomyContentProposal(
  admin: Admin,
  job: {
    organization_id: string;
    site_id: string | null;
    created_by: string;
    payload: unknown;
  },
) {
  const db = admin as DB;
  const actionId = (job.payload as { actionId?: string } | null)?.actionId;
  if (!job.site_id || !actionId)
    throw new Error("autonomy.content.propose requires site_id+actionId");
  const { data: action, error } = await db
    .from("autonomy_actions")
    .select("*")
    .eq("id", actionId)
    .eq("organization_id", job.organization_id)
    .single();
  if (error || !action) throw new Error("Autonomy action not found");
  const { data: policy } = await db
    .from("autonomy_policies")
    .select("*")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .single();
  if (!policy?.enabled || policy.kill_switch)
    throw new Error("Autonomy policy does not permit proposal");

  const before = action.before_snapshot as {
    url: string;
    title: string;
    excerpt: string;
    contentHtml: string;
  };
  const evidence = action.evidence ?? {};
  const proposal = await callLovableAIStructured<RefreshProposal>(
    [
      "You are the controlled editorial engine for a production WordPress publisher.",
      "Improve ONLY the supplied existing page using facts already present in the page and supplied Search Console queries.",
      "Do not invent statistics, prices, product claims, testing, credentials, citations, experience, reviews, dates, or external facts.",
      "Preserve every existing image URL, affiliate link, internal link, embed, disclosure and materially useful section.",
      "Do not change the URL or topic. Do not keyword-stuff. Do not add fake FAQs.",
      "Prioritize a direct answer early, clearer headings, decision support, semantic coverage, readability, and extraction-friendly structure.",
      "Return complete Classic-Editor-compatible HTML for the article body, with no markdown fences or placeholders.",
    ].join(" "),
    `URL: ${before.url}\nGSC evidence: ${JSON.stringify(evidence)}\n\nCURRENT TITLE:\n${before.title}\n\nCURRENT EXCERPT:\n${before.excerpt}\n\nCURRENT HTML:\n${before.contentHtml}`,
    "content_refresh",
    {
      type: "object",
      properties: {
        title: { type: "string" },
        excerpt: { type: "string" },
        content_html: { type: "string" },
        summary: { type: "string" },
      },
      required: ["title", "excerpt", "content_html", "summary"],
      additionalProperties: false,
    },
  );

  const validation = validateContentRefresh({
    url: before.url,
    beforeTitle: before.title,
    beforeExcerpt: before.excerpt,
    beforeHtml: before.contentHtml,
    nextTitle: proposal.title,
    nextExcerpt: proposal.excerpt,
    nextHtml: proposal.content_html,
    minimumQualityScore: policy.minimum_quality_score,
  });
  const beforeHash = await sha256(`${before.title}\n${before.excerpt}\n${before.contentHtml}`);
  await db
    .from("autonomy_actions")
    .update({
      proposed_snapshot: {
        title: proposal.title,
        excerpt: proposal.excerpt,
        contentHtml: proposal.content_html,
        summary: proposal.summary,
        beforeHash,
      },
      validation,
      status: validation.ok ? "approved" : "rejected",
    })
    .eq("id", actionId);

  if (validation.ok && (policy.mode === "canary" || policy.mode === "autopilot")) {
    await enqueueUnique(admin, {
      organization_id: job.organization_id,
      site_id: job.site_id,
      created_by: job.created_by,
      job_type: "autonomy.content.apply",
      payload: { actionId },
      priority: 70,
      idempotency_key: `hermes:${job.site_id}:${ymd()}:content-apply:${action.post_id}`,
    });
  }
  return { actionId, validation, mode: policy.mode };
}

export async function runAutonomyContentApply(
  admin: Admin,
  job: {
    organization_id: string;
    site_id: string | null;
    created_by: string;
    payload: unknown;
  },
) {
  const db = admin as DB;
  const actionId = (job.payload as { actionId?: string } | null)?.actionId;
  if (!job.site_id || !actionId)
    throw new Error("autonomy.content.apply requires site_id+actionId");
  const [{ data: action }, { data: policy }] = await Promise.all([
    db
      .from("autonomy_actions")
      .select("*")
      .eq("id", actionId)
      .eq("organization_id", job.organization_id)
      .single(),
    db
      .from("autonomy_policies")
      .select("*")
      .eq("organization_id", job.organization_id)
      .eq("site_id", job.site_id)
      .single(),
  ]);
  if (!action || !policy) throw new Error("Autonomy action or policy missing");
  if (!policy.enabled || policy.kill_switch || !["canary", "autopilot"].includes(policy.mode)) {
    throw new Error("Live content write blocked by autonomy policy");
  }
  if (action.status !== "approved")
    throw new Error(`Action status ${action.status} is not approved`);
  const today = `${ymd()}T00:00:00.000Z`;
  const { count } = await db
    .from("autonomy_actions")
    .select("id", { count: "exact", head: true })
    .eq("site_id", job.site_id)
    .in("status", ["applied", "verified"])
    .gte("applied_at", today);
  if ((count ?? 0) >= policy.daily_content_write_limit)
    throw new Error("Daily content write limit reached");

  const { data: post } = await db
    .from("wordpress_posts")
    .select("id,wp_post_id,post_type,url")
    .eq("id", action.post_id)
    .single();
  if (!post) throw new Error("WordPress post mapping missing");
  const conn = await getWpConnection(admin, job.organization_id, job.site_id);
  if (!conn) throw new Error("WordPress connection missing");
  const liveBefore = await fetchWpPost(conn, post.post_type, post.wp_post_id);
  const liveTitle = liveBefore.title.raw ?? stripHtml(liveBefore.title.rendered ?? "");
  const liveExcerpt = liveBefore.excerpt.raw ?? liveBefore.excerpt.rendered ?? "";
  const liveHtml = liveBefore.content.raw ?? liveBefore.content.rendered ?? "";
  const liveHash = await sha256(`${liveTitle}\n${liveExcerpt}\n${liveHtml}`);
  const proposed = action.proposed_snapshot as {
    title: string;
    excerpt: string;
    contentHtml: string;
    beforeHash: string;
  };
  if (!proposed.beforeHash || liveHash !== proposed.beforeHash) {
    await db
      .from("autonomy_actions")
      .update({
        status: "rejected",
        validation: { ok: false, reasons: ["live WordPress content changed after proposal"] },
      })
      .eq("id", actionId);
    throw new Error("Stale proposal: live WordPress content changed after proposal");
  }

  await db.from("autonomy_actions").update({ status: "applying" }).eq("id", actionId);
  try {
    await updateWpPost(conn, post.post_type, post.wp_post_id, {
      title: proposed.title,
      excerpt: proposed.excerpt,
      content: proposed.contentHtml,
    });
    const liveAfter = await fetchWpPost(conn, post.post_type, post.wp_post_id);
    const afterTitle = liveAfter.title.raw ?? stripHtml(liveAfter.title.rendered ?? "");
    const afterExcerpt = liveAfter.excerpt.raw ?? liveAfter.excerpt.rendered ?? "";
    const afterHtml = liveAfter.content.raw ?? liveAfter.content.rendered ?? "";
    const verify = validateContentRefresh({
      url: post.url,
      beforeTitle: liveTitle,
      beforeExcerpt: liveExcerpt,
      beforeHtml: liveHtml,
      nextTitle: afterTitle,
      nextExcerpt: afterExcerpt,
      nextHtml: afterHtml,
      minimumQualityScore: policy.minimum_quality_score,
    });
    const titleMatches = stripHtml(afterTitle).trim() === stripHtml(proposed.title).trim();
    if (!verify.ok || !titleMatches) {
      await updateWpPost(conn, post.post_type, post.wp_post_id, {
        title: liveTitle,
        excerpt: liveExcerpt,
        content: liveHtml,
      });
      await db
        .from("autonomy_actions")
        .update({
          status: "rolled_back",
          validation: { ...verify, readbackTitleMatches: titleMatches },
        })
        .eq("id", actionId);
      throw new Error(
        `WordPress validation failed; rolled back: ${verify.reasons.join("; ") || "title mismatch"}`,
      );
    }

    const afterHash = await sha256(`${afterTitle}\n${afterExcerpt}\n${afterHtml}`);
    const { data: changeset, error: csError } = await db
      .from("content_changesets")
      .insert({
        organization_id: job.organization_id,
        site_id: job.site_id,
        post_id: post.id,
        wp_post_id: post.wp_post_id,
        source: "hermes_autonomy",
        asset_blocks_added: ["content_refresh"],
        before_hash: liveHash,
        after_hash: afterHash,
        before_snapshot: {
          title: liveTitle,
          excerpt: liveExcerpt,
          content: liveHtml,
          url: post.url,
        },
        after_snapshot: {
          title: afterTitle,
          excerpt: afterExcerpt,
          content: afterHtml,
          url: post.url,
        },
        applied_by: job.created_by,
      })
      .select("id")
      .single();
    if (csError) throw csError;
    await db
      .from("autonomy_actions")
      .update({
        status: "verified",
        after_snapshot: { title: afterTitle, excerpt: afterExcerpt, contentHtml: afterHtml },
        validation: { ...verify, readbackTitleMatches: true },
        changeset_id: changeset.id,
        applied_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
      })
      .eq("id", actionId);
    return { actionId, changesetId: changeset.id, verified: true };
  } catch (e) {
    const { data: current } = await db
      .from("autonomy_actions")
      .select("status")
      .eq("id", actionId)
      .single();
    if (current?.status === "applying")
      await db.from("autonomy_actions").update({ status: "failed" }).eq("id", actionId);
    throw e;
  }
}

function formatLocalDateTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}`;
}

type SocialPlan = { posts: Array<{ network: string; text: string }> };

export async function runSocialPlan(
  admin: Admin,
  job: {
    organization_id: string;
    site_id: string | null;
    created_by: string;
    payload: unknown;
  },
) {
  if (!job.site_id) throw new Error("social.plan requires site_id");
  const db = admin as DB;
  const { data: policy } = await db
    .from("autonomy_policies")
    .select("*")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .single();
  if (!policy?.enabled || policy.kill_switch || !policy.social_provider)
    return { queued: 0, reason: "social disabled" };
  const networks = (Array.isArray(policy.social_networks) ? policy.social_networks : [])
    .map(String)
    .slice(0, policy.daily_social_post_limit);
  if (!networks.length) return { queued: 0, reason: "no networks" };
  const preferred = (job.payload as { preferredPostId?: string } | null)?.preferredPostId;
  let q = db
    .from("wordpress_posts")
    .select("id,url,title,excerpt,content_text")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .eq("status", "publish");
  if (preferred) q = q.eq("id", preferred);
  const { data: rows } = await q.limit(1);
  const post = rows?.[0];
  if (!post?.url || !post?.title) return { queued: 0, reason: "no source post" };

  const plan = await callLovableAIStructured<SocialPlan>(
    "Write platform-native social copy grounded only in the supplied article. Never invent claims or imply personal testing. Be useful, concise and non-clickbait. Each post must include the exact source URL once. Return no hashtags unless genuinely useful, maximum 3. Do not repeat identical wording across networks.",
    `Networks: ${networks.join(", ")}\nTitle: ${post.title}\nExcerpt: ${post.excerpt ?? ""}\nSource URL: ${post.url}\nArticle text: ${String(post.content_text ?? "").slice(0, 8000)}`,
    "social_plan",
    {
      type: "object",
      properties: {
        posts: {
          type: "array",
          items: {
            type: "object",
            properties: { network: { type: "string" }, text: { type: "string" } },
            required: ["network", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["posts"],
      additionalProperties: false,
    },
  );

  let queued = 0;
  const base = Date.now() + 15 * 60_000;
  for (const [i, item] of plan.posts.entries()) {
    if (!networks.includes(item.network)) continue;
    let text = item.text.trim();
    if (!text.includes(post.url)) text = `${text}\n\n${post.url}`;
    if (/\b(?:guaranteed|miracle|100% proven)\b/i.test(text)) continue;
    const key = `social:${job.site_id}:${ymd()}:${item.network}:${post.id}`;
    const { error } = await db.from("social_outbox").insert({
      organization_id: job.organization_id,
      site_id: job.site_id,
      source_post_id: post.id,
      source_url: post.url,
      provider: policy.social_provider,
      network: item.network,
      text,
      scheduled_at: new Date(base + i * 45 * 60_000).toISOString(),
      idempotency_key: key,
      status: "queued",
    });
    if (!error || error.code === "23505") queued += error ? 0 : 1;
  }
  if (queued > 0) {
    await enqueueUnique(admin, {
      organization_id: job.organization_id,
      site_id: job.site_id,
      created_by: job.created_by,
      job_type: "social.publish",
      payload: {},
      priority: 10,
      idempotency_key: `hermes:${job.site_id}:${ymd()}:social-publish`,
    });
  }
  return { queued, networks };
}

export async function runSocialPublish(
  admin: Admin,
  job: {
    organization_id: string;
    site_id: string | null;
  },
) {
  if (!job.site_id) throw new Error("social.publish requires site_id");
  const db = admin as DB;
  const { data: policy } = await db
    .from("autonomy_policies")
    .select("*")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .single();
  if (!policy?.enabled || policy.kill_switch || !["canary", "autopilot"].includes(policy.mode)) {
    return { published: 0, reason: "live social publishing blocked by policy" };
  }
  if (policy.social_provider !== "metricool")
    throw new Error(`Unsupported social provider: ${policy.social_provider}`);
  const token = process.env.METRICOOL_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  const blogId = policy.config?.metricool_blog_id;
  if (!token || !userId || !blogId)
    throw new Error("Metricool server credentials/blog mapping are not configured");
  const { data: due, error } = await db
    .from("social_outbox")
    .select("*")
    .eq("organization_id", job.organization_id)
    .eq("site_id", job.site_id)
    .eq("provider", "metricool")
    .eq("status", "queued")
    .lte("scheduled_at", new Date(Date.now() + 60 * 60_000).toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(Math.min(3, policy.daily_social_post_limit));
  if (error) throw error;
  let published = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const item of due ?? []) {
    try {
      await db.from("social_outbox").update({ status: "publishing" }).eq("id", item.id);
      // Metricool requires a future local dateTime. Keep a 5-minute buffer even
      // when the local outbox item is already due.
      const remoteDate = new Date(
        Math.max(Date.now() + 5 * 60_000, new Date(item.scheduled_at).getTime()),
      );
      const body = {
        publicationDate: {
          dateTime: formatLocalDateTime(remoteDate, policy.timezone),
          timezone: policy.timezone,
        },
        text: item.text,
        providers: [{ network: item.network }],
        autoPublish: true,
        draft: false,
        shortener: false,
        saveExternalMediaFiles: false,
      };
      const res = await fetch(
        `https://app.metricool.com/api/v2/scheduler/posts?blogId=${encodeURIComponent(String(blogId))}&userId=${encodeURIComponent(String(userId))}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Mc-Auth": token },
          body: JSON.stringify(body),
        },
      );
      const raw = await res.text();
      let parsed: DB = { raw: raw.slice(0, 2000) };
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* keep safe text */
      }
      if (!res.ok) throw new Error(`Metricool HTTP ${res.status}: ${raw.slice(0, 300)}`);
      const providerPostId = String(parsed?.id ?? parsed?.postId ?? parsed?.data?.id ?? "");
      await db
        .from("social_outbox")
        .update({
          status: "scheduled",
          provider_post_id: providerPostId || null,
          provider_response: parsed as Json,
          last_error: null,
        })
        .eq("id", item.id);
      published++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ id: item.id, error: message });
      await db
        .from("social_outbox")
        .update({ status: "failed", last_error: message.slice(0, 500) })
        .eq("id", item.id);
    }
  }
  return { scheduled: published, failed: failures.length, failures };
}
