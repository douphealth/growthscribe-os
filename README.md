# GrowthScribe OS

An AI-powered organic growth command center for WordPress publishers,
affiliate marketers, and SEO teams. GrowthScribe OS helps you improve
rankings, topical authority, AI-search visibility (AEO/GEO), and revenue —
without mass-publishing low-quality AI content.

## Features

- Multi-tenant workspaces with role-based access (owner / admin / editor / analyst / viewer)
- Executive dashboard with sites, health, and topical authority scores
- AI-driven content audits, briefs, and recommendations
- Topical maps, internal-link opportunities, and AEO/GEO scoring
- WordPress sync and approval-based draft publishing
- Verified GSC ingestion with freshness, failure, and portfolio data-trust evidence
- GA4 property mapping (configuration only; Analytics Data API ingestion is not enabled yet)
- Experimental AI response scenarios with disclosed model provenance (not live-engine visibility)
- Audit logs and editorial task workflows

## Tech Stack

- **Frontend:** React 19, TanStack Start (Router + Query), Vite 7, Tailwind v4, shadcn/ui
- **Backend:** TanStack `createServerFn` server functions, Cloudflare Workers runtime
- **Database & Auth:** Lovable Cloud (Supabase: Postgres + Auth + RLS)
- **AI:** Lovable AI Gateway (Gemini, GPT-5, Claude families)
- **Validation:** Zod end-to-end

## Local Setup

```bash
bun install
cp .env.example .env   # then fill in values
bun run dev
```

Useful scripts:

| Script              | Purpose                   |
| ------------------- | ------------------------- |
| `bun run dev`       | Start the Vite dev server |
| `bun run build`     | Production build          |
| `bun run typecheck` | Strict TypeScript check   |
| `bun run lint`      | ESLint                    |
| `bun run check`     | typecheck + lint          |
| `bun run test`      | Run Vitest suite          |
| `bun run db:types`  | Regenerate Supabase types |

## Environment Variables

See `.env.example` for the full list. Public (browser-safe):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`

Server-only (never expose to the client):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LOVABLE_API_KEY`

## Backend / Database

The database is provisioned through Lovable Cloud. Schema migrations live
under `supabase/migrations/` and are applied automatically on deploy.

Key tables: `organizations`, `organization_members`, `sites`,
`wordpress_posts`, `content_audits`, `content_scores`,
`content_recommendations`, `content_briefs`, `topical_clusters`,
`internal_link_opportunities`, `ai_visibility_tests`,
`approval_requests`, `background_jobs`, `audit_logs`, `tasks`,
`integration_connections`.

## Security Model

- **Row Level Security** is enabled on every business table. All access is
  scoped through `is_org_member(auth.uid(), organization_id)` and
  `has_org_role(auth.uid(), org_id, role)` security-definer helpers.
- **Roles** are stored in `user_roles` (global) and `organization_members`
  (per-workspace) — never on the `profiles` table — preventing privilege
  escalation.
- **Server functions** use `requireSupabaseAuth` so the bearer token is
  validated on every RPC. Org membership is re-checked server-side before
  any write.
- **Admin client** (`client.server.ts`) is restricted to webhooks and
  trusted server routes; it never enters client bundles.
- **Audit logs** capture sensitive actions and are readable only by org
  admins.

## Capability contract

| Capability            | Current evidence level                                                       |
| --------------------- | ---------------------------------------------------------------------------- |
| Google Search Console | Live connector, queued ingestion, imported metrics, freshness telemetry      |
| WordPress             | Credential verification, content sync, approval-based draft workflows        |
| GA4                   | Property mapping only; no imported metrics or Realtime/Data API proof        |
| AI Response Lab       | Disclosed model simulations; not ChatGPT/Gemini/Perplexity live observations |
| Portfolio dashboard   | Membership-scoped aggregation with deterministic data-trust gates            |

The UI must not promote a provider from `configured` to `verified` without a
successful probe or fresh imported evidence. No-op jobs must fail explicitly
instead of reporting success.

## Roadmap

- GA4 OAuth, Analytics Data API metric ingestion, and Realtime verification
- Provider-specific WordPress and GA4 freshness telemetry in the portfolio RPC
- Live-engine AEO/GEO observations through supported first-party APIs
- Evidence-calibrated recommendation scoring and outcome measurement
- Approval workflow UI with diff view and one-click publish
- Stripe-based plans, seats and usage metering
- Background-jobs worker (pg_cron + TanStack server routes)

## License

Proprietary — © GrowthScribe. All rights reserved.

## Portfolio Control Plane

Phase 3 is deployed from `main`: membership-scoped portfolio aggregation, canonical-domain reporting, operational health, and queued GSC management across all managed organizations.
