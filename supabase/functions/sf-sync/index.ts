// sf-sync — writes the app's placements to Salesforce Staffing__c expense fields.
//
// Called two ways:
//   1. Daily by pg_cron, with header  x-cron-key: <CRON_KEY>
//   2. By the "Sync all" button, with the signed-in editor's Supabase JWT.
//
// Rules (Colson, 20 Oct 2026):
//   - Delta sync: new Salesforce value = what Salesforce holds now + (app target - what the app already put there).
//     Spend Salesforce knows about and the app doesn't (Capital One, older hand entries) is never erased.
//   - Charges that haven't cleared yet are not synced (handled in sf_sync_plan()).
//   - A field someone changed by hand since the last sync is skipped and flagged until an editor accepts it.
//   - A field is never pushed below zero; that is flagged instead.
//   - All writes in one run go as composite PATCH allOrNone, then every record is re-read to confirm.
//   - Travel_Expense_Total__c is recomputed (six categories, mileage excluded) whenever a category changes.
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "v60.0";
const CATS = ["flights", "baggage", "hotels", "transportation", "per_diem", "other", "mileage"] as const;
type Cat = typeof CATS[number];
const FIELD: Record<Cat, string> = {
  flights: "Travel_Expense_Flights__c",
  baggage: "Travel_Expense_Baggage_Fees__c",
  hotels: "Travel_Expense_Hotels__c",
  transportation: "Travel_Expense_Transportation__c",
  per_diem: "Travel_Expense_Per_Diem__c",
  other: "Travel_Expense_Other__c",
  mileage: "Mileage_Reimbursement__c",
};
const TOTAL = "Travel_Expense_Total__c";
const IN_TOTAL: Cat[] = ["flights", "baggage", "hotels", "transportation", "per_diem", "other"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const toCents = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const toDollars = (c: number) => Math.round(c) / 100;

async function sfToken() {
  const domain = Deno.env.get("SF_DOMAIN"); // e.g. https://yourdomain.my.salesforce.com
  const id = Deno.env.get("SF_CLIENT_ID");
  const secret = Deno.env.get("SF_CLIENT_SECRET");
  if (!domain || !id || !secret) return null;
  const r = await fetch(`${domain.replace(/\/$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`Salesforce sign-in failed: ${b.error_description || b.error || r.status}`);
  return { token: b.access_token as string, base: (b.instance_url as string) || domain };
}

async function sfReadRecords(sf: { token: string; base: string }, ids: string[]) {
  const out: Record<string, Record<string, unknown>> = {};
  const fields = ["Id", ...CATS.map((c) => FIELD[c]), TOTAL].join(", ");
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map((x) => `'${x.replace(/'/g, "")}'`).join(",");
    const q = encodeURIComponent(`SELECT ${fields} FROM Staffing__c WHERE Id IN (${chunk})`);
    const r = await fetch(`${sf.base}/services/data/${API}/query?q=${q}`, { headers: { Authorization: `Bearer ${sf.token}` } });
    const b = await r.json();
    if (!r.ok) throw new Error(`Salesforce read failed: ${JSON.stringify(b).slice(0, 400)}`);
    for (const rec of b.records) out[(rec.Id as string).slice(0, 18)] = rec;
  }
  return out;
}

// Salesforce Ids come back 18 chars; the snapshot may hold 15 or 18. Match on the first 15.
const key15 = (id: string) => id.slice(0, 15);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- who is calling
  let trigger: "daily" | "button" = "button";
  let who = "";
  const sentKey = req.headers.get("x-cron-key");
  let cronKey = Deno.env.get("CRON_KEY") || "";
  if (sentKey && !cronKey) {
    const { data } = await service.from("sf_sync_secret").select("value").eq("name", "cron_key").maybeSingle();
    cronKey = data?.value || "";
  }
  if (sentKey && cronKey && sentKey === cronKey) {
    trigger = "daily"; who = "schedule";
  } else {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sign in first." }, 401);
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data, error } = await asUser.rpc("app_me");
    const me = data?.[0];
    if (error || !me?.is_editor) return json({ error: "Only editors can sync to Salesforce." }, 403);
    who = me.email;
  }

  let dryRun = false;
  try { dryRun = !!(await req.json())?.dry_run; } catch { /* no body */ }

  const { data: cfg } = await service.from("app_config").select("key,value").eq("key", "sf_sync_enabled");
  if (cfg?.[0] && cfg[0].value === false) return json({ status: "disabled", message: "Sync is switched off in app_config." });

  // one run at a time
  const { data: running } = await service.from("sf_sync_run").select("id,started_at").eq("status", "running")
    .gte("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  if (running?.length) return json({ status: "busy", message: "A sync is already running. Try again in a minute." }, 409);

  const { data: run, error: runErr } = await service.from("sf_sync_run")
    .insert({ trigger, triggered_by: who }).select("id").single();
  if (runErr) return json({ error: runErr.message }, 500);
  const runId = run.id as string;
  const batchId = crypto.randomUUID();

  const finish = async (status: string, message: string, written: unknown[] = [], totals: unknown[] = [],
                        seen: unknown[] = [], flags: unknown[] = []) => {
    const { error } = await service.rpc("sf_sync_finish", {
      p_run: runId, p_batch: written.length ? batchId : null, p_written: written, p_totals: totals,
      p_seen: seen, p_flags: flags, p_status: status, p_message: message,
    });
    if (error) await service.from("sf_sync_run").update({ status: "failed", finished_at: new Date().toISOString(), message: `${message} | finish error: ${error.message}` }).eq("id", runId);
    return json({ run_id: runId, status, message, fields_written: written.length, flags: flags.length });
  };

  try {
    const { data: plan, error: planErr } = await service.rpc("sf_sync_plan");
    if (planErr) throw new Error(planErr.message);
    const rows = (plan || []) as Array<{
      staffing_sf_id: string; sf_category: Cat; delta_cents: number; target_cents: number; ledger_cents: number;
      last_value_cents: number | null; has_state: boolean; has_open_flag: boolean; full_name: string | null; opportunity_name: string;
    }>;
    const actionable = rows.filter((r) => !r.has_open_flag);
    if (!actionable.length) {
      const held = rows.length - actionable.length;
      return await finish("nothing_to_do", held ? `Nothing new to sync. ${held} field(s) wait on a flag.` : "Salesforce is already up to date.");
    }

    const sf = await sfToken();
    if (!sf) {
      return await finish("not_connected",
        `Salesforce is not connected yet, so nothing was written. ${actionable.length} field(s) are ready to sync.`);
    }

    const ids = [...new Set(actionable.map((r) => r.staffing_sf_id))];
    const live = await sfReadRecords(sf, ids);
    const liveBy15: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(live)) liveBy15[key15(k)] = v;

    const seen: unknown[] = [];
    const flags: unknown[] = [];
    const writes = new Map<string, { id: string; cats: Partial<Record<Cat, { prev: number | null; next: number }>> }>();

    for (const r of actionable) {
      const rec = liveBy15[key15(r.staffing_sf_id)];
      if (!rec) {
        flags.push({ staffing_sf_id: r.staffing_sf_id, sf_category: r.sf_category, kind: "write_error",
          delta_cents: r.delta_cents, detail: "Staffing record not found in Salesforce (deleted or no access)." });
        continue;
      }
      const cur = toCents(rec[FIELD[r.sf_category]]);
      seen.push({ staffing_sf_id: r.staffing_sf_id, sf_category: r.sf_category, value_cents: cur });

      if (r.has_state && (r.last_value_cents ?? 0) !== (cur ?? 0)) {
        flags.push({ staffing_sf_id: r.staffing_sf_id, sf_category: r.sf_category, kind: "hand_edit",
          sf_value_cents: cur ?? 0, expected_cents: r.last_value_cents ?? 0, delta_cents: r.delta_cents,
          detail: "Changed in Salesforce since the last sync. Skipped so the hand edit is not overwritten." });
        continue;
      }
      const next = (cur ?? 0) + r.delta_cents;
      if (next < 0) {
        flags.push({ staffing_sf_id: r.staffing_sf_id, sf_category: r.sf_category, kind: "would_go_negative",
          sf_value_cents: cur ?? 0, expected_cents: next, delta_cents: r.delta_cents,
          detail: "Removing this would take the field below zero, so it was left alone." });
        continue;
      }
      const w = writes.get(rec.Id as string) || { id: rec.Id as string, cats: {} };
      w.cats[r.sf_category] = { prev: cur, next };
      writes.set(rec.Id as string, w);
    }

    if (!writes.size) {
      return await finish(flags.length ? "partial" : "nothing_to_do",
        flags.length ? `Nothing written. ${flags.length} field(s) flagged for a look.` : "Nothing to write.", [], [], seen, flags);
    }

    // payloads, with the recomputed total
    const payloads: Record<string, unknown>[] = [];
    const written: unknown[] = [];
    const totals: unknown[] = [];
    const owner: { w: number[]; t: number[] }[] = []; // which written/totals entries each payload carries
    const snapshotIdFor = (sfId: string) => actionable.find((r) => key15(r.staffing_sf_id) === key15(sfId))!.staffing_sf_id;
    for (const w of writes.values()) {
      const rec = live[(w.id).slice(0, 18)] || liveBy15[key15(w.id)];
      const p: Record<string, unknown> = { attributes: { type: "Staffing__c" }, id: w.id };
      const own = { w: [] as number[], t: [] as number[] };
      for (const [c, v] of Object.entries(w.cats) as [Cat, { prev: number | null; next: number }][]) {
        p[FIELD[c]] = toDollars(v.next);
        own.w.push(written.push({ staffing_sf_id: snapshotIdFor(w.id), sf_category: c, previous_cents: v.prev, new_cents: v.next }) - 1);
      }
      if (Object.keys(w.cats).some((c) => c !== "mileage")) {
        const newTotal = IN_TOTAL.reduce((s, c) => s + (w.cats[c]?.next ?? toCents(rec[FIELD[c]]) ?? 0), 0);
        p[TOTAL] = toDollars(newTotal);
        own.t.push(totals.push({ staffing_sf_id: snapshotIdFor(w.id), previous_cents: toCents(rec[TOTAL]), new_cents: newTotal }) - 1);
      }
      payloads.push(p); owner.push(own);
    }

    if (dryRun) {
      await service.from("sf_sync_run").update({ status: "nothing_to_do", finished_at: new Date().toISOString(),
        message: `Dry run: would write ${written.length} field(s) on ${payloads.length} record(s).` }).eq("id", runId);
      return json({ run_id: runId, status: "dry_run", payloads, flags });
    }

    for (let i = 0; i < payloads.length; i += 200) {
      const r = await fetch(`${sf.base}/services/data/${API}/composite/sobjects`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${sf.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ allOrNone: true, records: payloads.slice(i, i + 200) }),
      });
      const b = await r.json();
      const bad = Array.isArray(b) ? b.filter((x: { success: boolean }) => !x.success) : [b];
      if (!r.ok || bad.length) {
        // allOrNone: this chunk wrote nothing. Earlier chunks (only when >200 records) did, so log those.
        const done = owner.slice(0, i);
        return await finish(i === 0 ? "failed" : "partial", `Salesforce rejected the write: ${JSON.stringify(bad).slice(0, 500)}`,
          done.flatMap((o) => o.w.map((k) => written[k])), done.flatMap((o) => o.t.map((k) => totals[k])), seen, flags);
      }
    }

    // re-read and confirm every value landed
    const after = await sfReadRecords(sf, [...writes.keys()]);
    const mismatches: string[] = [];
    for (const w of writes.values()) {
      const rec = after[w.id.slice(0, 18)];
      for (const [c, v] of Object.entries(w.cats) as [Cat, { prev: number | null; next: number }][]) {
        if (toCents(rec?.[FIELD[c]]) !== v.next) mismatches.push(`${w.id} ${FIELD[c]}`);
      }
    }
    const msg = `Wrote ${written.length} field(s) on ${payloads.length} record(s).` +
      (flags.length ? ` ${flags.length} field(s) flagged.` : "") +
      (mismatches.length ? ` Re-read mismatch on: ${mismatches.join(", ")}` : "");
    return await finish(mismatches.length || flags.length ? "partial" : "ok", msg, written, totals, seen, flags);
  } catch (e) {
    return await finish("failed", (e as Error).message || String(e));
  }
});
