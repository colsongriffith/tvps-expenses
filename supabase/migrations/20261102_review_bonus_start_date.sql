-- Review bonuses were missing from the Wages tab (2 Nov 2026).
-- app_config has RLS on with no policy, so signed-in users read it as empty. v_app_review_bonus compared
-- event_date with a subquery on app_config, got null, and returned no rows. The service role never saw it.
-- Fix: expose only the one date the view needs. app_config itself stays closed. Approved by Colson.
create or replace function public.app_wage_sync_from_date() returns date
language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::date from app_config where key = 'wage_sync_from_event_date'
$$;
revoke all on function public.app_wage_sync_from_date() from public;
grant execute on function public.app_wage_sync_from_date() to authenticated, service_role;

create or replace view public.v_app_review_bonus with (security_invoker = on) as
 SELECT opportunity_sf_id,
    max(opportunity_name) AS opportunity_name,
    max(event_date) AS event_date,
    contact_sf_id,
    max(full_name) AS full_name,
    string_agg(DISTINCT role, ', '::text) AS roles,
    2500::bigint AS amount_cents,
    (EXISTS ( SELECT 1
           FROM payroll_extra_paid x
          WHERE x.active AND x.kind = 'review_bonus'::text AND x.opportunity_sf_id = r.opportunity_sf_id AND x.contact_sf_id = r.contact_sf_id)) AS paid
   FROM sf_review_source r
  WHERE google_review = '5 Star'::text AND is_wage_stage(( SELECT s.stage
           FROM staffing_snapshot s
          WHERE s.opportunity_sf_id = r.opportunity_sf_id
         LIMIT 1)) AND NOT is_remote_role(role) AND NOT is_salaried(full_name) AND event_date >= app_wage_sync_from_date()
  GROUP BY opportunity_sf_id, contact_sf_id;
