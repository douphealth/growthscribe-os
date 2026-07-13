-- No new legacy gsc_import jobs can be created after Phase 2. Cancel any that
-- were still queued at deployment time so they cannot bypass the gsc.pull
-- site/window lease. Historical completed/failed jobs remain unchanged.

UPDATE public.background_jobs
SET status = 'cancelled',
    finished_at = now(),
    last_error = 'cancelled: legacy gsc_import retired; enqueue gsc.pull instead',
    payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
      'category', 'migration',
      'phase', 'phase-2-hardening',
      'cancel_reason', 'legacy_gsc_import_retired'
    )
WHERE job_type = 'gsc_import'
  AND status = 'queued';
