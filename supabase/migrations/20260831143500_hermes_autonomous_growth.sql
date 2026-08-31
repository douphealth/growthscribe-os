-- Hermes Autonomous Growth control plane.
-- Adds policy, run/action evidence, and a social outbox without enabling
-- production mutation by default. Activation is explicit per site.

CREATE TABLE public.autonomy_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe','propose','canary','autopilot')),
  timezone text NOT NULL DEFAULT 'Europe/Athens',
  daily_content_write_limit integer NOT NULL DEFAULT 1 CHECK (daily_content_write_limit BETWEEN 0 AND 10),
  daily_social_post_limit integer NOT NULL DEFAULT 2 CHECK (daily_social_post_limit BETWEEN 0 AND 20),
  minimum_quality_score integer NOT NULL DEFAULT 75 CHECK (minimum_quality_score BETWEEN 0 AND 100),
  minimum_confidence numeric NOT NULL DEFAULT 0.70 CHECK (minimum_confidence BETWEEN 0 AND 1),
  max_risk text NOT NULL DEFAULT 'low' CHECK (max_risk IN ('low','medium','high')),
  social_provider text,
  social_networks jsonb NOT NULL DEFAULT '[]'::jsonb,
  kill_switch boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, site_id)
);
CREATE INDEX idx_autonomy_policies_site ON public.autonomy_policies(site_id);
ALTER TABLE public.autonomy_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members autonomy policies" ON public.autonomy_policies
  FOR ALL TO authenticated
  USING (is_org_member(auth.uid(), organization_id))
  WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE TRIGGER autonomy_policies_updated BEFORE UPDATE ON public.autonomy_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.autonomy_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id uuid NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed','blocked')),
  objective text NOT NULL DEFAULT 'organic_growth',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX idx_autonomy_runs_site_time ON public.autonomy_runs(site_id, started_at DESC);
ALTER TABLE public.autonomy_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members autonomy runs read" ON public.autonomy_runs
  FOR SELECT TO authenticated USING (is_org_member(auth.uid(), organization_id));

CREATE TABLE public.autonomy_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.autonomy_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  site_id uuid NOT NULL,
  post_id uuid,
  action_type text NOT NULL,
  risk text NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','applying','applied','verified','rolled_back','rejected','failed')),
  priority_score numeric NOT NULL DEFAULT 0,
  confidence numeric NOT NULL DEFAULT 0,
  rationale text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  changeset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  verified_at timestamptz
);
CREATE INDEX idx_autonomy_actions_queue ON public.autonomy_actions(site_id, status, priority_score DESC);
ALTER TABLE public.autonomy_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members autonomy actions read" ON public.autonomy_actions
  FOR SELECT TO authenticated USING (is_org_member(auth.uid(), organization_id));

CREATE TABLE public.social_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id uuid NOT NULL,
  source_post_id uuid,
  source_url text NOT NULL,
  provider text NOT NULL,
  network text NOT NULL,
  text text NOT NULL,
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','publishing','scheduled','published','failed','cancelled')),
  scheduled_at timestamptz NOT NULL,
  provider_post_id text,
  provider_response jsonb,
  published_at timestamptz,
  last_error text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_social_outbox_due ON public.social_outbox(status, scheduled_at);
CREATE INDEX idx_social_outbox_site ON public.social_outbox(site_id, created_at DESC);
ALTER TABLE public.social_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members social outbox read" ON public.social_outbox
  FOR SELECT TO authenticated USING (is_org_member(auth.uid(), organization_id));
CREATE TRIGGER social_outbox_updated BEFORE UPDATE ON public.social_outbox
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.autonomy_policies IS 'Per-site safety and autonomy policy. Defaults to disabled/observe.';
COMMENT ON TABLE public.autonomy_actions IS 'Evidence-backed proposed/applied actions with before/after snapshots and validation.';
COMMENT ON TABLE public.social_outbox IS 'Idempotent social publishing queue; provider credentials remain server-side.';
