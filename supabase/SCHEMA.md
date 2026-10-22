# Supabase schema (project `apzwwfuvoggiyfzgazdp`), snapshot 22 Oct 2026

Most of the schema was built by hand through the Supabase MCP tool between Sep and Oct 2026, before this repo existed. New changes go in `supabase/migrations/`. The tables the app depends on are below. `match_best_v*` / `match_run_*` tables come from older matcher generations and are not used by the app.

## Tables
- `expense_line` (one per charge): id, source_id, external_id, txn_date, pay_period_start, pay_period_end, amount_cents, currency, direction, merchant_name, merchant_category_raw, description, memo, payer_name, payer_person_id, state, intent, fine_category, raw_payload, ingested_at, superseded_by
- `expense_source`: id, system (ramp | gusto | capital_one | manual), account_ref, description, last_synced_at
- `allocation_current` (where each charge sits; rows deactivated, never deleted): id, expense_line_id, staffing_sf_id, opportunity_sf_id, contact_sf_id, sf_category, amount_cents, status, basis, note, writeback_batch_id, override_id, updated_at, active, superseded_at, confidence, confidence_reason
- `allocation_override` (every human change): id, expense_line_id, action, staffing_sf_id, opportunity_sf_id, contact_sf_id, sf_category, amount_cents, reason, decided_by, decided_at, applied_at, superseded_by, split_staffing_ids
- `staffing_snapshot` (Salesforce Staffing__c): staffing_sf_id, opportunity_sf_id, contact_sf_id, opportunity_name, role, event_date, venue_city, venue_state, shift_start, shift_end, travel_gig_workflow, sf_*_cents, sf_total_cents, fetched_at, stage
- `person`: id, contact_sf_id, full_name, ramp_user_name, gusto_employee_uuid, is_ops_buyer, active, created_at, email, ramp_user_uuid
- `app_user`: email, display_name, role (viewer | editor | admin)
- `app_config`: key, value, effective_at, note, updated_at
- `ramp_sync_run`: id, trigger, triggered_by, status, from_date, started_at, finished_at, fetched, new_lines, updated_lines, categorized, high, medium, low, message
- `sf_sync_run`, `sf_sync_ledger`, `sf_field_state`, `sf_sync_flag`, `sf_sync_secret`, `writeback_log`: Salesforce sync bookkeeping
- `billed_line_snapshot`, `event_billing`, `product_category_map`: what each event billed, used for the budget comparison
- `memo_notice`: Ramp comments asking card holders to fix memos

## Views the app reads (all `security_invoker`)
`v_app_event`, `v_app_line`, `v_app_crew`, `v_app_reconciliation`, `v_app_sync_queue`, `v_app_sync_flag`

## Functions
- Auth: `app_current_email()`, `app_is_member()` (any @thevanityportraitstudio.com), `app_is_editor()`, `app_is_admin()`, `app_me()`
- Triggers on `allocation_override`: `validate_allocation_override()` (before insert), `apply_allocation_override()` (after insert)
- Salesforce sync: `sf_sync_plan()`, `sf_sync_finish(...)`, `sf_sync_flag_accept(uuid)`, `sf_sync_kick(text)`, `app_sync_queue()`
- Ramp: `ramp_sync_kick()` (called by pg_cron)
- Older matcher helpers: `is_clear_overhead`, `is_clear_event`, `names_in_text`, `destinations_in_text`, `sig_tokens`, …

## Scheduled jobs (pg_cron)
- `sf-sync-daily`: `7 13 * * *` → `sf_sync_kick('daily')`
- `ramp-sync-daily`: `37 12 * * *` → `ramp_sync_kick()`
