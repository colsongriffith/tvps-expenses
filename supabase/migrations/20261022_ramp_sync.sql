-- Sync from Ramp button + Claude categorization (22 Oct 2026)

-- One row per pull from Ramp (button or schedule).
create table if not exists ramp_sync_run (
  id uuid primary key default gen_random_uuid(),
  trigger text not null default 'button',
  triggered_by text,
  status text not null default 'running',   -- running | ok | partial | failed | not_connected | busy
  from_date date,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched int, new_lines int, updated_lines int, categorized int,
  high int, medium int, low int,
  message text
);
alter table ramp_sync_run enable row level security;
create policy app_member_read_ramp_sync_run on ramp_sync_run for select to authenticated using (app_is_member());
grant select on ramp_sync_run to authenticated;

-- Anyone signed in with a TVPS email can categorize (Colson, 22 Oct). Every change still records who made it.
-- (The older app_editor_insert_override policy is left in place; policies are OR'd, so members can now insert.)
create policy app_member_insert_override on allocation_override for insert to authenticated
  with check (app_is_member() and decided_by = app_current_email());

-- Daily pull, 30 minutes before the Salesforce sync (sf-sync-daily runs 13:07 UTC).
create or replace function ramp_sync_kick() returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://apzwwfuvoggiyfzgazdp.supabase.co/functions/v1/ramp-sync',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-cron-key', (select value from sf_sync_secret where name = 'cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000);
$$;
revoke all on function ramp_sync_kick() from public, anon, authenticated;
