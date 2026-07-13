-- Atomic queue claiming with per-organization fairness and a platform-wide
-- maximum of two concurrently running GSC imports. Locking and window ranking
-- intentionally live in separate CTEs: PostgreSQL rejects window functions in
-- the same SELECT that uses FOR UPDATE SKIP LOCKED.

CREATE OR REPLACE FUNCTION public.claim_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_max_running_per_org integer DEFAULT 3,
  p_max_running_gsc integer DEFAULT 2
)
RETURNS SETOF public.background_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH running_by_org AS (
    SELECT organization_id, count(*)::integer AS running_count
    FROM public.background_jobs
    WHERE status = 'running'
    GROUP BY organization_id
  ),
  running_gsc AS (
    SELECT count(*)::integer AS running_count
    FROM public.background_jobs
    WHERE status = 'running' AND job_type = 'gsc.pull'
  ),
  locked AS MATERIALIZED (
    SELECT j.*
    FROM public.background_jobs AS j
    WHERE j.status = 'queued'
      AND j.next_run_at <= now()
    ORDER BY j.priority DESC, j.next_run_at ASC, j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED
    LIMIT GREATEST(1, p_limit) * 10
  ),
  ranked AS (
    SELECT
      l.id,
      l.organization_id,
      l.job_type,
      l.priority,
      l.next_run_at,
      l.created_at,
      row_number() OVER (
        PARTITION BY l.organization_id
        ORDER BY l.priority DESC, l.next_run_at ASC, l.created_at ASC
      ) AS org_rank,
      row_number() OVER (
        PARTITION BY l.job_type
        ORDER BY l.priority DESC, l.next_run_at ASC, l.created_at ASC
      ) AS type_rank
    FROM locked AS l
  ),
  eligible AS (
    SELECT r.id
    FROM ranked AS r
    LEFT JOIN running_by_org AS ro ON ro.organization_id = r.organization_id
    CROSS JOIN running_gsc AS rg
    WHERE r.org_rank <= GREATEST(0, p_max_running_per_org - COALESCE(ro.running_count, 0))
      AND (
        r.job_type <> 'gsc.pull'
        OR r.type_rank <= GREATEST(0, p_max_running_gsc - rg.running_count)
      )
    ORDER BY r.priority DESC, r.next_run_at ASC, r.created_at ASC
    LIMIT GREATEST(1, p_limit)
  ),
  claimed AS (
    UPDATE public.background_jobs AS j
    SET status = 'running',
        started_at = now(),
        finished_at = NULL,
        locked_at = now(),
        locked_by = p_worker_id
    FROM eligible AS e
    WHERE j.id = e.id
    RETURNING j.*
  )
  SELECT * FROM claimed;
$$;

REVOKE ALL ON FUNCTION public.claim_jobs(text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_jobs(text, integer, integer, integer) TO service_role;
