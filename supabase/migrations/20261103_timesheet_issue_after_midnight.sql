-- Colson, 3 Nov 2026: the TVPS workday runs until 4 am. A Gusto entry that starts between 12:00 and 4:00 am
-- belongs to the day before, so the whole day must be moved earlier in Gusto to end by 11:59 pm
-- (otherwise Gusto splits the hours across two days and undercounts overtime).
-- New employee-facing reason 'after_midnight'; like other employee issues it holds the record back from the wage sync.
-- Applied to apzwwfuvoggiyfzgazdp on 3 Nov 2026 as written here.
do $mig$
declare d text; cols text; blk text; q text;
begin
  d := pg_get_viewdef('public.v_app_timesheet_issue'::regclass, true);
  if position('after_midnight' in d) > 0 then raise notice 'already there'; return; end if;
  cols := substring(d from $r$SELECT 'mixed_entry'::text AS text,(.*?)FROM c\s+WHERE c\."position"$r$);
  if cols is null then raise exception 'column list not found'; end if;
  blk := E'\n                UNION ALL\n                 SELECT ''after_midnight''::text AS text,' || cols ||
         E'FROM c\n                  WHERE EXTRACT(hour FROM (c.clock_in AT TIME ZONE ''America/Los_Angeles''::text)) < 4::numeric\n                ';
  d := regexp_replace(d, '\), rec AS \(', blk || '), rec AS (');
  execute 'create or replace view public.v_app_timesheet_issue with (security_invoker = on) as ' || d;

  q := pg_get_viewdef('public.v_timesheet_email_queue'::regclass, true);
  q := regexp_replace(q, $r$WHEN 'no_on_site'::text THEN$r$,
    $w$WHEN 'after_midnight'::text THEN format('- %s, %s to %s (%s h) starts after midnight. Our workday runs until 4 am, so this time belongs to %s. Please move that whole day earlier in Gusto by the same amount (usually 2 to 3 hours) so it ends by 11:59 pm on %s, keep the total hours the same, and add a note on the entries that you shifted them. This keeps your overtime on one day.'::text, pt_day(r.work_date), pt_time(r.clock_in), pt_time(r.clock_out), r.hours, pt_day(r.work_date - 1), pt_day(r.work_date - 1))
                    WHEN 'no_on_site'::text THEN$w$);
  if position('after_midnight' in q) = 0 then raise exception 'email queue not patched'; end if;
  execute 'create or replace view public.v_timesheet_email_queue with (security_invoker = on) as ' || q;
end $mig$;
