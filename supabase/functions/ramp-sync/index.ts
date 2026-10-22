// ramp-sync: pulls card transactions from Ramp into expense_line and asks Claude for a best-guess placement.
//
// Called by:
//   - the "Sync from Ramp" button (any signed-in TVPS member, using their Supabase JWT)
//   - pg_cron daily, with header x-cron-key (same key as sf-sync)
//
// Rules:
//   - Re-pulls a rolling window (last charge date minus 60 days) so memo edits and pending→cleared changes are picked up.
//   - New charges land as `suggested` / `held` / high-confidence `overhead`. Nothing counts until someone presses Add.
//   - A charge a person has already placed is never re-guessed. If its amount changes in Ramp it is reported, not moved.
//   - Dates are the UTC date of the card transaction (the convention every run has used).
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { rampToken, rampTransactions } from "./ramp.ts";
import { askClaude, Charge, Event, eventsFor, Placement, toRows } from "./categorize.ts";

export const RAMP_SOURCE = "5941e287-68bc-4200-a793-73cc057133b5";
const BATCH = 20;          // charges per Claude call
const PARALLEL = 3;        // Claude calls at once
const MAX_CATEGORIZE = 160; // per run; the rest are held and picked up next run
const LOOKBACK_DAYS = 60;   // re-read this far back so late memos and amount changes are picked up
const AUTO_BASES = ["claude", "ramp_sync_guess", "pending_claude", "intent:ambiguous", "no_memo"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const isAuto = (basis: string | null) => !!basis && AUTO_BASES.some((b) => basis.startsWith(b));
const lineState = (s: string): "pending" | "cleared" | "void" | null =>
  s === "PENDING" ? "pending" : ["DECLINED", "ERROR"].includes(s) ? null : ["CANCELED", "CANCELLED", "VOID", "VOIDED"].includes(s) ? "void" : "cleared";

async function chunked<T>(ids: string[], size: number, fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...await fn(ids.slice(i, i + size)));
  return out;
}

export async function handler(req: Request, deps: { fetch?: typeof fetch; db?: SupabaseClient } = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const f = deps.fetch ?? fetch;
  const url = Deno.env.get("SUPABASE_URL")!;
  const db = deps.db ?? createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- who is calling
  let trigger = "button", who = "";
  const sentKey = req.headers.get("x-cron-key");
  if (sentKey) {
    const { data } = await db.from("sf_sync_secret").select("value").eq("name", "cron_key").maybeSingle();
    if (!data?.value || data.value !== sentKey) return json({ error: "Bad schedule key." }, 401);
    trigger = "daily"; who = "schedule";
  } else {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sign in first." }, 401);
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data, error } = await asUser.rpc("app_me");
    const me = data?.[0];
    if (error || !me?.is_member) return json({ error: "Sign in with your TVPS email to sync." }, 403);
    who = me.email;
  }
  let body: { from_date?: string } = {};
  try { body = await req.json(); } catch { /* no body */ }

  const rampId = Deno.env.get("RAMP_CLIENT_ID"), rampSecret = Deno.env.get("RAMP_CLIENT_SECRET");
  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY");
  const model = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
  if (!rampId || !rampSecret) {
    await db.from("ramp_sync_run").insert({ trigger, triggered_by: who, status: "not_connected", finished_at: new Date().toISOString(),
      message: "Ramp is not connected yet. Add RAMP_CLIENT_ID and RAMP_CLIENT_SECRET in Supabase → Edge Functions → Secrets." });
    return json({ status: "not_connected", message: "Ramp isn't connected yet. Ask Colson to add the Ramp API keys." });
  }

  // ---- one run at a time
  const { data: running } = await db.from("ramp_sync_run").select("id").eq("status", "running")
    .gte("started_at", new Date(Date.now() - 6 * 60_000).toISOString());
  if (running?.length) return json({ status: "busy", message: "A Ramp sync is already running. Give it a minute." }, 409);

  // ---- window
  let from = body.from_date && /^\d{4}-\d{2}-\d{2}$/.test(body.from_date) ? body.from_date : "";
  if (!from) {
    const { data: last } = await db.from("expense_line").select("txn_date").eq("source_id", RAMP_SOURCE)
      .not("txn_date", "is", null).order("txn_date", { ascending: false }).limit(1);
    const lastDate = last?.[0]?.txn_date ? new Date(last[0].txn_date + "T00:00:00Z") : new Date(Date.now() - 30 * 864e5);
    from = new Date(lastDate.getTime() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  }
  const { data: run, error: runErr } = await db.from("ramp_sync_run")
    .insert({ trigger, triggered_by: who, status: "running", from_date: from }).select("id").single();
  if (runErr) return json({ error: runErr.message }, 500);
  const runId = run.id as string;
  const finish = async (status: string, fields: Record<string, unknown>) => {
    await db.from("ramp_sync_run").update({ status, finished_at: new Date().toISOString(), ...fields }).eq("id", runId);
    return json({ run_id: runId, status, ...fields });
  };

  try {
    const token = await rampToken(rampId, rampSecret, f);
    const txns = (await rampTransactions(token, from, f)).filter((t) => t.utcDate && lineState(t.state));

    // people by Ramp user id
    const { data: people } = await db.from("person").select("id, full_name, contact_sf_id, ramp_user_uuid, is_ops_buyer");
    const byRamp = new Map((people || []).filter((p) => p.ramp_user_uuid).map((p) => [p.ramp_user_uuid as string, p]));

    // existing lines
    const ids = txns.map((t) => t.id);
    const existing = await chunked(ids, 150, async (part) => {
      const { data, error } = await db.from("expense_line").select("id, external_id, memo, amount_cents, state, raw_payload")
        .eq("source_id", RAMP_SOURCE).in("external_id", part);
      if (error) throw new Error(error.message);
      return data || [];
    });
    const byExt = new Map(existing.map((e) => [e.external_id as string, e]));

    const toInsert: Record<string, unknown>[] = [], memoChanged: string[] = [], amountChanged: { id: string; cents: number; merchant: string | null }[] = [];
    let updated = 0;
    for (const t of txns) {
      const person = t.userId ? byRamp.get(t.userId) : undefined;
      const st = lineState(t.state)!;
      const e = byExt.get(t.id);
      if (!e) {
        toInsert.push({
          source_id: RAMP_SOURCE, external_id: t.id, txn_date: t.utcDate, amount_cents: t.amountCents,
          direction: t.amountCents < 0 ? "credit" : "debit", merchant_name: t.merchant, merchant_category_raw: t.merchantCategory,
          memo: t.memo, payer_name: person?.full_name || t.userName, payer_person_id: person?.id || null, state: st,
          intent: "unclassified",
          raw_payload: { pulled: new Date().toISOString().slice(0, 10), pulled_by: who, receipt_count: t.receiptCount,
            ramp_user_uuid: t.userId, ramp_time: t.time, ramp_accounting_category: t.accountingCategory },
        });
        continue;
      }
      const patch: Record<string, unknown> = {};
      if ((e.memo || null) !== (t.memo || null)) { patch.memo = t.memo; memoChanged.push(e.id as string); }
      if (e.state !== st) patch.state = st;
      if (e.amount_cents !== t.amountCents) {
        patch.amount_cents = t.amountCents;
        patch.direction = t.amountCents < 0 ? "credit" : "debit";
        amountChanged.push({ id: e.id as string, cents: t.amountCents, merchant: t.merchant });
      }
      if (Object.keys(patch).length) {
        patch.raw_payload = { ...(e.raw_payload as object || {}), refreshed: new Date().toISOString().slice(0, 10), receipt_count: t.receiptCount };
        const { error } = await db.from("expense_line").update(patch).eq("id", e.id);
        if (error) throw new Error(`Updating ${t.merchant}: ${error.message}`);
        updated++;
      }
    }

    const inserted = toInsert.length
      ? (await chunked(toInsert.map((_, i) => String(i)), 100, async (part) => {
          const { data, error } = await db.from("expense_line").insert(part.map((i) => toInsert[+i])).select("id");
          if (error) throw new Error(error.message);
          return data || [];
        })).map((r) => r.id as string)
      : [];

    // ---- which lines Claude should (re)guess
    const touched = [...new Set([...memoChanged, ...amountChanged.map((a) => a.id)])];
    const { data: pendingHeld } = await db.from("allocation_current").select("expense_line_id")
      .eq("active", true).eq("basis", "pending_claude");
    const candidates = [...new Set([...touched, ...(pendingHeld || []).map((r) => r.expense_line_id as string)])];
    const attention: string[] = [];
    const reguess: string[] = [];
    if (candidates.length) {
      const allocs = await chunked(candidates, 150, async (part) => {
        const { data, error } = await db.from("allocation_current").select("id, expense_line_id, status, basis, override_id")
          .eq("active", true).in("expense_line_id", part);
        if (error) throw new Error(error.message);
        return data || [];
      });
      const byLine = new Map<string, typeof allocs>();
      for (const a of allocs) byLine.set(a.expense_line_id as string, [...(byLine.get(a.expense_line_id as string) || []), a]);
      for (const id of candidates) {
        const rows = byLine.get(id) || [];
        const untouched = rows.every((r) => !r.override_id && ["suggested", "held"].includes(r.status as string) && isAuto(r.basis as string));
        if (untouched) reguess.push(id);
        else if (amountChanged.some((a) => a.id === id)) {
          const a = amountChanged.find((x) => x.id === id)!;
          attention.push(`${a.merchant || "A charge"} changed to $${(a.cents / 100).toFixed(2)} in Ramp after it was placed`);
        }
      }
    }
    const work = [...inserted, ...reguess];
    const now = work.slice(0, MAX_CATEGORIZE), later = work.slice(MAX_CATEGORIZE);

    // ---- build Claude's context
    const lines = now.length ? await chunked(now, 150, async (part) => {
      const { data, error } = await db.from("expense_line")
        .select("id, txn_date, amount_cents, merchant_name, merchant_category_raw, memo, payer_name, payer_person_id, raw_payload").in("id", part);
      if (error) throw new Error(error.message);
      return data || [];
    }) : [];
    const byPerson = new Map((people || []).map((p) => [p.id as string, p]));
    const charges: Charge[] = lines.map((l) => {
      const p = l.payer_person_id ? byPerson.get(l.payer_person_id as string) : undefined;
      return {
        line_id: l.id as string, date: l.txn_date as string, amount_cents: l.amount_cents as number, merchant: l.merchant_name as string,
        merchant_category: l.merchant_category_raw as string, memo: l.memo as string, card_holder: (p?.full_name || l.payer_name) as string,
        card_holder_contact: (p?.contact_sf_id as string) || null, is_ops_buyer: !!p?.is_ops_buyer,
        receipt_count: ((l.raw_payload as Record<string, number>)?.receipt_count) || 0,
      };
    });

    let events: Event[] = [];
    if (charges.length) {
      const ds = charges.map((c) => c.date).sort();
      const lo = new Date(new Date(ds[0] + "T00:00:00Z").getTime() - 30 * 864e5).toISOString().slice(0, 10);
      const hi = new Date(new Date(ds[ds.length - 1] + "T00:00:00Z").getTime() + 75 * 864e5).toISOString().slice(0, 10);
      const { data: snap, error } = await db.from("staffing_snapshot")
        .select("staffing_sf_id, opportunity_sf_id, opportunity_name, event_date, venue_city, venue_state, contact_sf_id, role, stage")
        .gte("event_date", lo).lte("event_date", hi).neq("stage", "Closed Lost");
      if (error) throw new Error(error.message);
      const names = new Map((people || []).filter((p) => p.contact_sf_id).map((p) => [p.contact_sf_id as string, p.full_name as string]));
      const m = new Map<string, Event>();
      for (const s of snap || []) {
        const k = s.opportunity_sf_id as string;
        if (!m.has(k)) m.set(k, { opportunity_sf_id: k, name: s.opportunity_name as string, date: s.event_date as string, city: s.venue_city as string, state: s.venue_state as string, crew: [] });
        m.get(k)!.crew.push({ staffing_sf_id: s.staffing_sf_id as string, contact_sf_id: s.contact_sf_id as string,
          name: s.contact_sf_id ? names.get(s.contact_sf_id as string) || null : null, role: s.role as string });
      }
      events = [...m.values()];
    }

    // ---- ask Claude, in batches
    const answers = new Map<string, Placement>();
    let claudeNote = "";
    if (charges.length && claudeKey) {
      const batches: Charge[][] = [];
      for (let i = 0; i < charges.length; i += BATCH) batches.push(charges.slice(i, i + BATCH));
      for (let i = 0; i < batches.length; i += PARALLEL) {
        const res = await Promise.allSettled(batches.slice(i, i + PARALLEL).map((b) => askClaude(claudeKey, model, b, eventsFor(b, events), f)));
        for (const r of res) {
          if (r.status === "fulfilled") for (const p of r.value) answers.set(p.charge_id, p);
          else claudeNote = String(r.reason?.message || r.reason).slice(0, 200);
        }
      }
    } else if (charges.length) claudeNote = "Claude isn't connected (ANTHROPIC_API_KEY missing), so new charges came in without a guess.";

    // ---- write placements
    const conf = { high: 0, medium: 0, low: 0 };
    let waiting = 0;
    const allRows: Record<string, unknown>[] = [], lineUpdates: { id: string; intent: string; fine_category: string | null }[] = [];
    for (const c of charges) {
      const p = answers.get(c.line_id);
      const { rows, line } = toRows(c, p, events, `claude:${model}`);
      if (!p) {
        const why = claudeKey ? "Claude didn't answer this time. It will try again on the next sync." : "Not categorized yet. Claude isn't connected.";
        rows.forEach((r) => { r.basis = "pending_claude"; r.note = r.confidence_reason = why; });
        waiting++;
      } else conf[rows[0].confidence]++;
      allRows.push(...rows);
      lineUpdates.push(line);
    }
    for (const id of later) {
      const l = { expense_line_id: id, amount_cents: 0, status: "held", basis: "pending_claude", note: "Waiting for Claude. Press Sync again to categorize.",
        confidence: "low", confidence_reason: "Waiting for Claude. Press Sync again to categorize." };
      const { data } = await db.from("expense_line").select("amount_cents").eq("id", id).single();
      l.amount_cents = data?.amount_cents ?? 0;
      allRows.push(l);
    }
    const replace = [...new Set([...reguess, ...later])];
    if (replace.length) {
      for (let i = 0; i < replace.length; i += 150) {
        const { error } = await db.from("allocation_current").update({ active: false, superseded_at: new Date().toISOString() })
          .eq("active", true).in("expense_line_id", replace.slice(i, i + 150));
        if (error) throw new Error(error.message);
      }
    }
    for (let i = 0; i < allRows.length; i += 200) {
      const { error } = await db.from("allocation_current").insert(allRows.slice(i, i + 200));
      if (error) throw new Error(error.message);
    }
    for (const u of lineUpdates) {
      await db.from("expense_line").update({ intent: u.intent, ...(u.fine_category ? { fine_category: u.fine_category } : {}) }).eq("id", u.id);
    }

    const parts = [`Pulled ${txns.length} charges from Ramp since ${from}.`,
      inserted.length ? `${inserted.length} new.` : "Nothing new.",
      updated ? `${updated} updated (memo, amount or pending→cleared).` : "",
      charges.length - waiting ? `Claude pre-filled ${charges.length - waiting}: ${conf.high} green, ${conf.medium} orange, ${conf.low} red.` : "",
      waiting + later.length ? `${waiting + later.length} still waiting for Claude; they'll be done on the next sync.` : "",
      attention.length ? `Check: ${attention.slice(0, 3).join("; ")}${attention.length > 3 ? ` and ${attention.length - 3} more` : ""}.` : "",
      claudeNote ? `Note: ${claudeNote}` : ""].filter(Boolean);
    return await finish(waiting || later.length ? "partial" : "ok", {
      fetched: txns.length, new_lines: inserted.length, updated_lines: updated, categorized: charges.length - waiting,
      high: conf.high, medium: conf.medium, low: conf.low, message: parts.join(" "),
    });
  } catch (e) {
    return await finish("failed", { message: String((e as Error)?.message || e).slice(0, 500) });
  }
}

if (!Deno.env.get("RAMP_SYNC_TEST")) Deno.serve((req) => handler(req));
