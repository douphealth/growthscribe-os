-- Phase 3: membership-scoped portfolio control plane.
--
-- This function is intentionally SECURITY INVOKER. It aggregates only rows the
-- authenticated caller can already read through RLS and additionally anchors
-- every organization through organization_members + auth.uid(). No service role
-- or cross-tenant data movement is involved.

CREATE OR REPLACE FUNCTION public.get_portfolio_control_plane(
  p_window_days integer DEFAULT 28
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT LEAST(90, GREATEST(7, COALESCE(p_window_days, 28)))::integer AS window_days
  ),
  member_orgs AS (
    SELECT
      o.id AS organization_id,
      o.name AS organization_name,
      m.role::text AS role
    FROM public.organization_members AS m
    JOIN public.organizations AS o ON o.id = m.organization_id
    WHERE m.user_id = auth.uid()
  ),
  gsc_connections AS (
    SELECT DISTINCT ON (ic.site_id)
      ic.site_id,
      ic.status::text AS gsc_status,
      ic.last_synced_at AS gsc_last_synced_at,
      ic.last_error AS gsc_last_error,
      ic.config ->> 'property' AS gsc_property
    FROM public.integration_connections AS ic
    JOIN member_orgs AS mo ON mo.organization_id = ic.organization_id
    WHERE ic.provider = 'gsc'
      AND ic.site_id IS NOT NULL
    ORDER BY
      ic.site_id,
      CASE WHEN ic.status = 'connected' THEN 0 ELSE 1 END,
      ic.updated_at DESC
  ),
  integration_rollup AS (
    SELECT
      ic.site_id,
      bool_or(ic.provider = 'wordpress' AND ic.status = 'connected') AS wordpress_connected,
      bool_or(ic.provider = 'ga4' AND ic.status = 'connected') AS ga4_connected
    FROM public.integration_connections AS ic
    JOIN member_orgs AS mo ON mo.organization_id = ic.organization_id
    WHERE ic.site_id IS NOT NULL
    GROUP BY ic.site_id
  ),
  site_base AS (
    SELECT
      s.id AS site_id,
      s.organization_id,
      mo.organization_name,
      mo.role,
      s.name,
      s.url,
      lower(
        regexp_replace(
          regexp_replace(s.url, '^https?://(www\.)?', '', 'i'),
          '/.*$',
          ''
        )
      ) AS domain,
      s.status::text AS site_status,
      s.health_score,
      s.topical_authority_score,
      s.total_posts,
      s.last_synced_at AS site_last_synced_at,
      COALESCE(gc.gsc_status, 'missing') AS gsc_status,
      gc.gsc_last_synced_at,
      gc.gsc_last_error,
      gc.gsc_property,
      COALESCE(ir.wordpress_connected, false) AS wordpress_connected,
      COALESCE(ir.ga4_connected, false) AS ga4_connected,
      row_number() OVER (
        PARTITION BY lower(
          regexp_replace(
            regexp_replace(s.url, '^https?://(www\.)?', '', 'i'),
            '/.*$',
            ''
          )
        )
        ORDER BY
          CASE WHEN gc.gsc_status = 'connected' THEN 0 ELSE 1 END,
          gc.gsc_last_synced_at DESC NULLS LAST,
          s.updated_at DESC,
          s.id
      ) AS canonical_rank
    FROM public.sites AS s
    JOIN member_orgs AS mo ON mo.organization_id = s.organization_id
    LEFT JOIN gsc_connections AS gc ON gc.site_id = s.id
    LEFT JOIN integration_rollup AS ir ON ir.site_id = s.id
  ),
  canonical_sites AS (
    SELECT * FROM site_base WHERE canonical_rank = 1
  ),
  site_bounds AS (
    SELECT sc.site_id, max(sc.date) AS latest_data_date
    FROM public.search_console_daily AS sc
    JOIN canonical_sites AS cs ON cs.site_id = sc.site_id
    GROUP BY sc.site_id
  ),
  gsc_metrics AS (
    SELECT
      sc.site_id,
      sum(sc.clicks) FILTER (
        WHERE sc.date BETWEEN sb.latest_data_date - (p.window_days - 1) AND sb.latest_data_date
      )::bigint AS clicks_current,
      sum(sc.impressions) FILTER (
        WHERE sc.date BETWEEN sb.latest_data_date - (p.window_days - 1) AND sb.latest_data_date
      )::bigint AS impressions_current,
      sum(sc.clicks) FILTER (
        WHERE sc.date BETWEEN sb.latest_data_date - (p.window_days * 2 - 1)
          AND sb.latest_data_date - p.window_days
      )::bigint AS clicks_previous,
      sum(sc.impressions) FILTER (
        WHERE sc.date BETWEEN sb.latest_data_date - (p.window_days * 2 - 1)
          AND sb.latest_data_date - p.window_days
      )::bigint AS impressions_previous,
      sum(sc.clicks) FILTER (
        WHERE sc.date BETWEEN sb.latest_data_date - 6 AND sb.latest_data_date
      )::bigint AS clicks_7d,
      sum(sc.impressions) FILTER (
        WHERE sc.date BETWEEN sb.latest_data_date - 6 AND sb.latest_data_date
      )::bigint AS impressions_7d,
      round(
        (
          sum(sc.position * sc.impressions) FILTER (
            WHERE sc.date BETWEEN sb.latest_data_date - (p.window_days - 1) AND sb.latest_data_date
          ) /
          NULLIF(
            sum(sc.impressions) FILTER (
              WHERE sc.date BETWEEN sb.latest_data_date - (p.window_days - 1) AND sb.latest_data_date
            ),
            0
          )
        )::numeric,
        1
      ) AS average_position
    FROM public.search_console_daily AS sc
    JOIN site_bounds AS sb ON sb.site_id = sc.site_id
    CROSS JOIN params AS p
    WHERE sc.date >= sb.latest_data_date - (p.window_days * 2 - 1)
    GROUP BY sc.site_id
  ),
  site_facts AS (
    SELECT
      cs.*,
      sb.latest_data_date,
      COALESCE(gm.clicks_current, 0) AS clicks_current,
      COALESCE(gm.impressions_current, 0) AS impressions_current,
      COALESCE(gm.clicks_previous, 0) AS clicks_previous,
      COALESCE(gm.impressions_previous, 0) AS impressions_previous,
      COALESCE(gm.clicks_7d, 0) AS clicks_7d,
      COALESCE(gm.impressions_7d, 0) AS impressions_7d,
      gm.average_position,
      COALESCE(task_stats.open_tasks, 0) AS open_tasks,
      COALESCE(approval_stats.pending_approvals, 0) AS pending_approvals,
      COALESCE(job_stats.active_jobs, 0) AS active_jobs,
      COALESCE(job_stats.failed_jobs_7d, 0) AS failed_jobs_7d,
      latest_job.status AS latest_gsc_job_status,
      latest_job.finished_at AS latest_gsc_job_finished_at
    FROM canonical_sites AS cs
    LEFT JOIN site_bounds AS sb ON sb.site_id = cs.site_id
    LEFT JOIN gsc_metrics AS gm ON gm.site_id = cs.site_id
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS open_tasks
      FROM public.tasks AS t
      WHERE t.site_id = cs.site_id
        AND t.status NOT IN ('published', 'archived')
    ) AS task_stats ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS pending_approvals
      FROM public.approval_requests AS ar
      WHERE ar.site_id = cs.site_id
        AND ar.status = 'pending'
    ) AS approval_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE bj.status IN ('queued', 'running'))::integer AS active_jobs,
        count(*) FILTER (
          WHERE bj.status = 'failed'
            AND bj.created_at >= now() - interval '7 days'
            AND COALESCE(bj.payload ->> 'category', '') <> 'setup'
        )::integer AS failed_jobs_7d
      FROM public.background_jobs AS bj
      WHERE bj.site_id = cs.site_id
    ) AS job_stats ON true
    LEFT JOIN LATERAL (
      SELECT bj.status::text AS status, bj.finished_at
      FROM public.background_jobs AS bj
      WHERE bj.site_id = cs.site_id AND bj.job_type = 'gsc.pull'
      ORDER BY bj.created_at DESC
      LIMIT 1
    ) AS latest_job ON true
  ),
  site_health AS (
    SELECT
      sf.*,
      CASE
        WHEN sf.gsc_status <> 'connected' OR sf.gsc_last_error IS NOT NULL THEN 'critical'
        WHEN sf.latest_data_date IS NULL
          OR current_date - sf.latest_data_date > 4
          OR sf.gsc_last_synced_at IS NULL
          OR now() - sf.gsc_last_synced_at > interval '36 hours' THEN 'stale'
        WHEN sf.failed_jobs_7d > 0 OR sf.site_status IN ('error', 'sync_failed', 'stale') THEN 'attention'
        ELSE 'healthy'
      END AS operational_state,
      (
        (CASE WHEN sf.gsc_status <> 'connected' THEN 1 ELSE 0 END) +
        (CASE WHEN sf.gsc_last_error IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN sf.latest_data_date IS NULL OR current_date - sf.latest_data_date > 4 THEN 1 ELSE 0 END) +
        (CASE WHEN sf.gsc_last_synced_at IS NULL OR now() - sf.gsc_last_synced_at > interval '36 hours' THEN 1 ELSE 0 END) +
        (CASE WHEN sf.failed_jobs_7d > 0 THEN sf.failed_jobs_7d ELSE 0 END)
      )::integer AS alert_count
    FROM site_facts AS sf
  ),
  portfolio_bound AS (
    SELECT max(latest_data_date) AS latest_data_date FROM site_health
  ),
  daily_trend AS (
    SELECT
      sc.date,
      sum(sc.clicks)::bigint AS clicks,
      sum(sc.impressions)::bigint AS impressions
    FROM public.search_console_daily AS sc
    JOIN site_health AS sh ON sh.site_id = sc.site_id
    CROSS JOIN portfolio_bound AS pb
    CROSS JOIN params AS p
    WHERE pb.latest_data_date IS NOT NULL
      AND sc.date BETWEEN pb.latest_data_date - (p.window_days - 1) AND pb.latest_data_date
    GROUP BY sc.date
    ORDER BY sc.date
  ),
  summary AS (
    SELECT
      count(*)::integer AS managed_sites,
      count(*) FILTER (WHERE gsc_status = 'connected')::integer AS connected_gsc,
      count(*) FILTER (WHERE operational_state = 'healthy')::integer AS healthy_sites,
      count(*) FILTER (WHERE operational_state <> 'healthy')::integer AS sites_needing_attention,
      COALESCE(sum(clicks_current), 0)::bigint AS total_clicks,
      COALESCE(sum(impressions_current), 0)::bigint AS total_impressions,
      COALESCE(sum(clicks_previous), 0)::bigint AS previous_clicks,
      COALESCE(sum(active_jobs), 0)::integer AS active_jobs,
      COALESCE(sum(pending_approvals), 0)::integer AS pending_approvals,
      min(latest_data_date) AS oldest_data_date,
      max(latest_data_date) AS latest_data_date
    FROM site_health
  )
  SELECT jsonb_build_object(
    'generatedAt', now(),
    'windowDays', p.window_days,
    'summary', jsonb_build_object(
      'organizations', (SELECT count(*) FROM member_orgs),
      'managedSites', s.managed_sites,
      'connectedGsc', s.connected_gsc,
      'healthySites', s.healthy_sites,
      'sitesNeedingAttention', s.sites_needing_attention,
      'totalClicks', s.total_clicks,
      'totalImpressions', s.total_impressions,
      'ctr', round((s.total_clicks::numeric / NULLIF(s.total_impressions, 0)) * 100, 2),
      'clickGrowthPct', round(
        ((s.total_clicks - s.previous_clicks)::numeric / NULLIF(s.previous_clicks, 0)) * 100,
        1
      ),
      'activeJobs', s.active_jobs,
      'pendingApprovals', s.pending_approvals,
      'oldestDataDate', s.oldest_data_date,
      'latestDataDate', s.latest_data_date,
      'duplicatesSuppressed', (SELECT count(*) FROM site_base) - s.managed_sites
    ),
    'sites', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'siteId', sh.site_id,
          'organizationId', sh.organization_id,
          'organizationName', sh.organization_name,
          'role', sh.role,
          'name', sh.name,
          'url', sh.url,
          'domain', sh.domain,
          'siteStatus', sh.site_status,
          'operationalState', sh.operational_state,
          'alertCount', sh.alert_count,
          'healthScore', sh.health_score,
          'authorityScore', sh.topical_authority_score,
          'totalPosts', sh.total_posts,
          'gscStatus', sh.gsc_status,
          'gscProperty', sh.gsc_property,
          'gscLastSyncedAt', sh.gsc_last_synced_at,
          'gscLastError', sh.gsc_last_error,
          'wordpressConnected', sh.wordpress_connected,
          'ga4Connected', sh.ga4_connected,
          'latestDataDate', sh.latest_data_date,
          'clicks', sh.clicks_current,
          'impressions', sh.impressions_current,
          'clicks7d', sh.clicks_7d,
          'impressions7d', sh.impressions_7d,
          'clickGrowthPct', round(
            ((sh.clicks_current - sh.clicks_previous)::numeric / NULLIF(sh.clicks_previous, 0)) * 100,
            1
          ),
          'ctr', round((sh.clicks_current::numeric / NULLIF(sh.impressions_current, 0)) * 100, 2),
          'averagePosition', sh.average_position,
          'openTasks', sh.open_tasks,
          'pendingApprovals', sh.pending_approvals,
          'activeJobs', sh.active_jobs,
          'failedJobs7d', sh.failed_jobs_7d,
          'latestGscJobStatus', sh.latest_gsc_job_status,
          'latestGscJobFinishedAt', sh.latest_gsc_job_finished_at
        )
        ORDER BY
          CASE sh.operational_state
            WHEN 'critical' THEN 0
            WHEN 'stale' THEN 1
            WHEN 'attention' THEN 2
            ELSE 3
          END,
          sh.clicks_current DESC,
          sh.domain
      )
      FROM site_health AS sh
    ), '[]'::jsonb),
    'trend', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'date', dt.date,
          'clicks', dt.clicks,
          'impressions', dt.impressions
        )
        ORDER BY dt.date
      )
      FROM daily_trend AS dt
    ), '[]'::jsonb)
  )
  FROM summary AS s
  CROSS JOIN params AS p;
$$;

REVOKE ALL ON FUNCTION public.get_portfolio_control_plane(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portfolio_control_plane(integer) TO authenticated;
