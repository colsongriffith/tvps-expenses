-- Applied 27 Oct 2026 as migration "timesheet_issue_ignore".
-- "Ignore" on a Timesheet-not-entered-properly line: an editor confirmed the time was approved and entered properly.
-- Append-only; the latest row per issue_key wins (ignored=false undoes it).
create table if not exists public.timesheet_issue_ignore (
  id uuid primary key default gen_random_uuid(),
  issue_key text not null,
  ignored boolean not null default true,
  staffing_sf_id text,
  wage_shift_id uuid,
  reason text,
  decided_by text not null,
  decided_at timestamptz not null default now(),
  note text
);
create index if not exists timesheet_issue_ignore_key on public.timesheet_issue_ignore (issue_key, decided_at desc);
alter table public.timesheet_issue_ignore enable row level security;
revoke all on public.timesheet_issue_ignore from anon;
grant select, insert on public.timesheet_issue_ignore to authenticated;
drop policy if exists app_member_read on public.timesheet_issue_ignore;
create policy app_member_read on public.timesheet_issue_ignore for select using (app_is_member());
drop policy if exists app_editor_insert on public.timesheet_issue_ignore;
create policy app_editor_insert on public.timesheet_issue_ignore for insert with check (app_is_editor() and decided_by = app_current_email());

create or replace view public.v_timesheet_issue_ignored with (security_invoker = on) as
select distinct on (issue_key) issue_key, ignored, decided_by, decided_at, note
from public.timesheet_issue_ignore order by issue_key, decided_at desc;
grant select on public.v_timesheet_issue_ignored to authenticated;

-- Same view as before, minus ignored lines. Dependents (v_app_wage_record sync ticks, v_timesheet_email_queue) see the filter too.
do $$
declare d text := pg_get_viewdef('public.v_app_timesheet_issue'::regclass);
begin
  if position('timesheet_issue_ignore' in d) > 0 then return; end if;
  d := regexp_replace(d, ';\s*$', '');
  execute 'create or replace view public.v_app_timesheet_issue with (security_invoker = on) as select x.* from (' || d ||
    ') x where not exists (select 1 from public.v_timesheet_issue_ignored g where g.issue_key = x.issue_key and g.ignored)';
end $$;
