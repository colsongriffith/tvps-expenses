# TVPS Event Expenses

Web app at https://tvps-expenses.vercel.app. It collects card and reimbursement charges (Ramp, Gusto, Capital One, manual entries), places each one on a Salesforce event + staffing record + expense category, and writes category totals back to Salesforce `Staffing__c`.

Owner: Colson Griffith (The Vanity Portrait Studio). Design history and run logs live in the claude.ai project "Expense Tracking For Gigs".

## Layout
- `web/` – front end. Plain ES modules with React 18 + htm, loaded from esm.sh. No framework build.
  - `src/app/*.js`, `base.css`, `grid.css`.
  - `node build.mjs` writes `deploy/` (what Vercel serves) and `test/dist.js` (the same code with Supabase swapped for `test/mock-supabase.js`).
  - `node e2e.mjs` runs Playwright against the mock. **It must end with `ERRORS: none`.**
- `supabase/functions/ramp-sync/` – the "Sync from Ramp" button and the daily pull.
  - `ramp.ts`: Ramp client-credentials token and transaction pages.
  - `categorize.ts`: Claude Messages API with JSON structured output (`output_config.format`). The house rules live in its system prompt.
  - `index.ts`: upserts and placements.
  - Test: `deno run -A supabase/functions/ramp-sync/test.ts`.
- `supabase/functions/sf-sync/` – delta sync to Salesforce (daily 13:07 UTC + "Sync all"). Test: `deno run -A supabase/functions/sf-sync/test.ts`.
- `supabase/migrations/` – SQL applied to the Supabase project `apzwwfuvoggiyfzgazdp`. Earlier schema was applied by hand; see `supabase/SCHEMA.md`.

## Data model (Supabase)
- `expense_line`: one per charge. The unique key is `(source_id, external_id)`.
  - Sources: Ramp `5941e287…`, Gusto, Capital One `e04b3a78…`, manual `7a3c9e10…`.
  - `txn_date` is the UTC date of the card transaction.
- `allocation_current`: where a charge sits, one row per share. Only `active` rows count. Rows are never deleted; they are deactivated.
  - `status` values:
    - `suggested`: a best guess. Counts nowhere until someone presses Add.
    - `held`: no guess, or not finished.
    - `proposed`: added; goes to Salesforce on the next sync.
    - `written`: in Salesforce.
    - `historical`: pre-tool. Records only, never syncs.
    - `overhead`.
  - `confidence` + `confidence_reason` drive the green/orange/red row colors.
- `allocation_override`: every human change. A trigger (`apply_allocation_override`) rewrites `allocation_current`.
  - Actions: `reassign`, `split`, `mark_overhead`, `unassign`, `remove`.
- `staffing_snapshot`: Salesforce staffing records (event × person). `person` maps Ramp user UUIDs and Salesforce contacts.
- `ramp_sync_run`, `sf_sync_run`: run logs. `sf_sync_ledger` / `sf_field_state`: what the app has written and the hand-edit detector.

## Rules that must not be broken
- Never write Salesforce by hand. The sync does it, and it is a delta: it never lowers a field and never overwrites a hand edit (those are flagged).
- A guess never counts until a person adds it. Never create `proposed` rows from automation.
- Never re-guess a charge a person has placed (anything with an override, or status proposed/written/historical).
- Pre-tool charges (`historical`) never sync.
- Multi-day trips: costs go on the first day's record. The memo beats date proximity.
- Closed Lost events never appear in any dropdown.
- Permissions:
  - Anyone signed in with an `@thevanityportraitstudio.com` email can pull from Ramp and categorize (`app_is_member()`).
  - Salesforce sync and accepting flags are editor-only (`app_is_editor()`).

## Secrets (Supabase → Edge Functions → Secrets; never in code)
- `RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET`: a Ramp Developer API app with Client Credentials and scopes `transactions:read users:read receipts:read`.
- `ANTHROPIC_API_KEY`. `CLAUDE_MODEL` is optional (default `claude-sonnet-5-5`).
- `SF_DOMAIN`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`: a Salesforce External Client App ("TVPS Expenses Sync") with the client-credentials flow, Run As Colson, IP relaxed. Set 22 Oct 2026; `SF_DOMAIN` = https://vanityportraitstudio.my.salesforce.com.

## Deploying
- Front end:
  - Vercel is git-linked to colsongriffith/tvps-expenses (since 22 Oct 2026): every push to `main` deploys to production.
  - Project settings (saved in Vercel): framework Other, root `web`, build `node build.mjs`, output `deploy`, install = default.
  - Run `cd web && node build.mjs && node e2e.mjs` before pushing; it must end with `ERRORS: none`.
  - After a push, fetch https://tvps-expenses.vercel.app/ and check it returns the app, not NOT_FOUND.
  - If deploying by API instead, always pass `projectSettings` (rootDirectory `web`, buildCommand `node build.mjs`, outputDirectory `deploy`); without them the site deploys as a 404.
- Functions: `supabase functions deploy ramp-sync --no-verify-jwt`, same for `sf-sync`. Both check auth themselves: a member JWT, or `x-cron-key` for pg_cron.
