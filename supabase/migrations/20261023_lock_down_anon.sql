-- Security audit 2026-10-23. The anon key ships in the web bundle and this repo is public, so the anon
-- role must not read or write anything. The app only queries after sign-in (authenticated role);
-- edge functions and pg_cron use the service role, which bypasses RLS.
alter table public.ramp_pull_1012 enable row level security;
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke all privileges on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
