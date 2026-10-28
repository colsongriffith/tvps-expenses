-- STATUS: written 28 Oct 2026, NOT YET APPLIED (it changes the live wage sync; waiting for Colson's OK).
-- Approved contractor invoices join the wage queue, so the normal wage sync (ticks, daily 6:37 push, flags)
-- writes their totals to On_Site_Wages__c on the Day 1 record. Hours are not written for invoices.

do $$
declare d text; f text;
begin
  -- 1. v_wage_queue: Gusto rows as before (source 'gusto'), plus one row per approved invoice target.
  d := pg_get_viewdef('public.v_wage_queue'::regclass);
  if position('v_contractor_wage' in d) = 0 then
    d := regexp_replace(d, ';\s*$', '');
    execute 'create or replace view public.v_wage_queue with (security_invoker = on) as
      select g.*, ''gusto''::text as source from (' || d || ') g
      union all
      select cw.staffing_sf_id, ss.opportunity_sf_id, ss.opportunity_name, ss.event_date, ss.contact_sf_id,
             coalesce(cp.full_name, ss.contact_sf_id) as person_name,
             true as is_day_one, cw.days > 1 as is_multi_day, cw.days::bigint as trip_days, 0::numeric as travel_day_shifts,
             ''high''::text as confidence, null::numeric as commute_hours, null::numeric as on_site_hours,
             null::bigint as commute_rate_cents, null::bigint as on_site_rate_cents, null::bigint as sf_contact_rate_cents,
             null::numeric as commute_wage_cents, cw.on_site_wage_cents::numeric as on_site_wage_cents,
             false as needs_role, ''invoice''::text as source
        from public.v_contractor_wage cw
        join public.staffing_snapshot ss on ss.staffing_sf_id = cw.staffing_sf_id
        left join public.sf_contact_pay cp on cp.contact_sf_id = ss.contact_sf_id
       where not exists (select 1 from public.wage_allocation wa where wa.staffing_sf_id = cw.staffing_sf_id and wa.active)';
  end if;

  -- 2. v_app_wage_record: an invoice row has wages but no hours; that is not "No on-site hours".
  d := pg_get_viewdef('public.v_app_wage_record'::regclass);
  if position('q_source' in d) = 0 then
    d := regexp_replace(d, ';\s*$', '');
    d := regexp_replace(d, 'q\.commute_wage_cents,', 'q.commute_wage_cents, q.source AS q_source,');
    d := replace(d, 'WHEN ((b.on_site_hours IS NULL) AND (NOT b.is_multi_day))',
                    'WHEN ((b.on_site_hours IS NULL) AND (NOT b.is_multi_day) AND (b.q_source = ''gusto''::text))');
    if position('b.q_source' in d) = 0 then raise exception 'v_app_wage_record: status rule not found'; end if;
    execute 'create or replace view public.v_app_wage_record with (security_invoker = on) as ' || d;
  end if;

  -- 3. wage_sync_plan: invoice records sync whatever their event date (the Oct 5 cut-off is for Gusto shifts).
  f := pg_get_functiondef('public.wage_sync_plan'::regproc);
  if position('v_contractor_wage' in f) = 0 then
    f := replace(f, 'where s.event_date >= cfg.d',
      'where (s.event_date >= cfg.d or exists (select 1 from v_contractor_wage cw where cw.staffing_sf_id = rc.staffing_sf_id))');
    if position('v_contractor_wage' in f) = 0 then raise exception 'wage_sync_plan: date filter not found'; end if;
    execute f;
  end if;
end $$;
