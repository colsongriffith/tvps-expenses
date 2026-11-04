-- Meetings, training and virtual headshot sessions are overhead, not event wages (Colson, 4 Nov 2026).
-- Before this, wage_match_shift put any same-day shift on that day's event, and admin time the day before
-- or after a gig on that gig as a travel day, even when the memo said "weekly meeting" or "virtual headshot".
-- About $598 of Oct 19 – Nov 1 time reached Salesforce that way.
--
-- New step, before the staffing match: if the Gusto memo names a meeting, training or a virtual session,
-- the shift goes to overhead (basis memo_overhead, confidence high). Exception: when an event the person
-- is staffed on within a day either side has the same word in its name (e.g. "Annual Meeting"), the
-- memo is about that event, so normal matching applies.
-- Only new shifts are matched; existing placements are never touched.

create or replace function public.wage_match_shift(p_shift uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record; v_contact text; v_bucket wage_role_type; v_n int; c record; par record;
  v_basis text; v_travel boolean := false; v_conf text; v_reason text; v_kw text;
begin
  if exists (select 1 from wage_allocation where wage_shift_id = p_shift and active) then return 'kept'; end if;
  select * into s from wage_shift where id = p_shift;

  if s.gusto_shift_id ~ '-\d{4}-\d{2}-\d{2}$' then
    select wa.* into par from wage_allocation wa join wage_shift ps on ps.id = wa.wage_shift_id
     where ps.gusto_shift_id = regexp_replace(s.gusto_shift_id, '-\d{4}-\d{2}-\d{2}$', '') and wa.active
     limit 1;
    if found then
      insert into wage_allocation (wage_shift_id, staffing_sf_id, opportunity_sf_id, contact_sf_id, bucket, equiv_hours, wage_cents,
                                   status, basis, confidence, confidence_reason, is_travel_day)
      values (p_shift, par.staffing_sf_id, par.opportunity_sf_id, par.contact_sf_id, par.bucket, coalesce(s.equiv_hours, 0), s.wage_cents,
              par.status, 'past_midnight_continuation', par.confidence, 'after-midnight part of the same Gusto shift', par.is_travel_day);
      return 'past_midnight_continuation';
    end if;
  end if;

  select contact_sf_id into v_contact from person where id = s.person_id;
  v_bucket := coalesce(s.role_type, 'on_site');

  -- Meetings, training and virtual sessions are overhead, unless a nearby event's own name uses the same word.
  if s.memo is not null then
    select k.word into v_kw
      from (values ('meeting', '\mmeetings?\M|\mmtgs?\M|all[ -]?hands'),
                   ('training', '\mtrainings?\M'),
                   ('virtual', '\mvirtuals?\M')) k(word, pat)
     where s.memo ~* k.pat
       and not exists (select 1 from staffing_snapshot ss
                        where v_contact is not null and ss.contact_sf_id = v_contact
                          and ss.event_date between s.work_date - 1 and s.work_date + 1
                          and is_wage_stage(ss.stage) and ss.opportunity_name ~* k.pat)
     limit 1;
    if v_kw is not null then
      insert into wage_allocation (wage_shift_id, bucket, equiv_hours, wage_cents, status, basis, confidence, confidence_reason, is_travel_day)
      values (p_shift, v_bucket, coalesce(s.equiv_hours, 0), s.wage_cents, 'overhead', 'memo_overhead', 'high',
              'memo says ' || v_kw || ': overhead, not event wages', false);
      return 'memo_overhead';
    end if;
  end if;

  if v_contact is not null then
    select count(*) into v_n from staffing_snapshot ss
     where ss.contact_sf_id = v_contact and ss.event_date = s.work_date and is_wage_stage(ss.stage);
    if v_n > 0 then
      select ss.* into c from staffing_snapshot ss
       where ss.contact_sf_id = v_contact and ss.event_date = s.work_date and is_wage_stage(ss.stage)
       order by greatest(0, extract(epoch from least(s.clock_out, ss.shift_end) - greatest(s.clock_in, ss.shift_start))) desc nulls last,
                ss.shift_start nulls last, ss.staffing_sf_id
       limit 1;
      v_basis := 'exact_staffing_match';
      v_conf := case when v_n = 1 then 'high' else 'medium' end;
      v_reason := case when v_n = 1 then null else 'staffed on ' || v_n || ' events this day' end;
    elsif v_bucket = 'admin' then
      select count(*) into v_n from staffing_snapshot ss
       where ss.contact_sf_id = v_contact and ss.event_date in (s.work_date - 1, s.work_date + 1) and is_wage_stage(ss.stage);
      if v_n > 0 then
        select ss.* into c from staffing_snapshot ss
         where ss.contact_sf_id = v_contact and ss.event_date in (s.work_date - 1, s.work_date + 1) and is_wage_stage(ss.stage)
         order by abs(extract(epoch from (s.clock_in + (s.clock_out - s.clock_in) / 2)
                   - coalesce(case when ss.event_date > s.work_date then ss.shift_start else ss.shift_end end,
                              (ss.event_date + time '12:00') at time zone 'America/Los_Angeles'))),
                  ss.staffing_sf_id
         limit 1;
        v_basis := case when c.event_date > s.work_date then 'travel_day_before' else 'travel_day_after' end;
        v_travel := true;
        v_conf := case when v_n = 1 then 'high' else 'medium' end;
        v_reason := 'travel day rolled onto Day 1' || case when v_n > 1 then '; ' || v_n || ' candidate trips' else '' end;
      end if;
    end if;
  end if;

  if v_basis is null then
    insert into wage_allocation (wage_shift_id, bucket, equiv_hours, wage_cents, status, basis, confidence, confidence_reason, is_travel_day)
    values (p_shift, v_bucket, coalesce(s.equiv_hours, 0), s.wage_cents, 'overhead',
            case when s.person_id is null then 'no_person' when v_contact is null then 'no_contact' else 'no_event' end, 'low',
            case when s.person_id is null then 'Gusto employee not linked to a person in the app'
                 when v_contact is null then 'person has no Salesforce contact'
                 when v_bucket = 'on_site' then 'on-site time with no staffing record that day'
                 else 'no staffing record on or adjacent to this date' end, false);
    return 'no_event';
  end if;

  insert into wage_allocation (wage_shift_id, staffing_sf_id, opportunity_sf_id, contact_sf_id, bucket, equiv_hours, wage_cents,
                               status, basis, confidence, confidence_reason, is_travel_day)
  values (p_shift, c.staffing_sf_id, c.opportunity_sf_id, c.contact_sf_id, case when v_travel then 'admin' else v_bucket end,
          coalesce(s.equiv_hours, 0), s.wage_cents, 'suggested', v_basis, v_conf, v_reason, v_travel);
  return v_basis;
end $function$;
