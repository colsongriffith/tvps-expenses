# TVPS Event Expenses

This app gets every card charge onto the right event, crew member and expense category, then keeps Salesforce staffing records up to date.

- **App:** https://tvps-expenses.vercel.app (sign in with your TVPS email)
- **Sync from Ramp:** pulls new Ramp charges. Claude pre-fills its best guess, colored green, orange or red by how sure it is. Nothing counts until someone presses **Add to event**.
- **Salesforce:** added charges sync daily at 6am Pacific, or when an admin presses **Sync all**.

Developer notes are in [CLAUDE.md](CLAUDE.md).

```bash
cd web && npm ci && node build.mjs && node e2e.mjs        # front end + browser tests
deno run -A supabase/functions/ramp-sync/test.ts          # Ramp + Claude sync tests
deno run -A supabase/functions/sf-sync/test.ts            # Salesforce sync tests
```
