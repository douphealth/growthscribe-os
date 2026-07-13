-- Phase 2: one idempotent GSC writer and one active job per site/date window.

CREATE UNIQUE INDEX IF NOT EXISTS uq_search_console_daily_natural
  ON public.search_console_daily (site_id, date, query, page) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gsc_pull_active
  ON public.background_jobs (
    site_id,
    (payload ->> 'start_date'),
    (payload ->> 'end_date')
  )
  WHERE job_type = 'gsc.pull'
    AND status IN ('queued', 'running');

-- Preserve the failed setup attempts as audit history while allowing operational
-- health views to exclude them from current production incidents.
UPDATE public.background_jobs
SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
  'category', 'setup',
  'phase', 'pre-phase-2',
  'classified_at', now()
)
WHERE job_type = 'gsc.pull'
  AND status = 'failed'
  AND created_at < '2026-07-13T08:35:53Z'::timestamptz
  AND NOT COALESCE(payload, '{}'::jsonb) ? 'phase';

