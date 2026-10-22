// Local test for ramp-sync. Run:  deno run -A supabase/functions/ramp-sync/test.ts
// Mocks: a tiny in-memory PostgREST (enough for supabase-js), the Ramp API and the Claude Messages API.
Deno.env.set("RAMP_SYNC_TEST", "1");
Deno.env.set("SUPABASE_URL", "https://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");
Deno.env.set("SUPABASE_ANON_KEY", "anon");

type Row = Record<string, unknown>;
const RAMP = "5941e287-68bc-4200-a793-73cc057133b5";
let seq = 0;
const T: Record<string, Row[]> = {
  sf_sync_secret: [{ name: "cron_key", value: "k" }],
  ramp_sync_run: [],
  person: [
    { id: "p-billy", full_name: "Billy Cole", contact_sf_id: "C_billy", ramp_user_uuid: "u-billy", is_ops_buyer: false },
    { id: "p-japhy", full_name: "Japhy Altenhein", contact_sf_id: "C_japhy", ramp_user_uuid: "u-japhy", is_ops_buyer: true },
  ],
  expense_line: [
    // already in the tool, placed by a person: memo + amount change must not move it
    { id: "L-old", source_id: RAMP, external_id: "r-old", txn_date: "2026-10-10", amount_cents: 5000, memo: null, state: "pending", raw_payload: {} },
    // already in the tool, auto-guessed, memo arrives now -> re-guess
    { id: "L-guess", source_id: RAMP, external_id: "r-guess", txn_date: "2026-10-12", amount_cents: 1800, memo: null, state: "cleared", raw_payload: {} },
  ],
  allocation_current: [
    { id: "A-old", expense_line_id: "L-old", status: "proposed", basis: "override", override_id: "O1", active: true, amount_cents: 5000 },
    { id: "A-guess", expense_line_id: "L-guess", status: "held", basis: "intent:ambiguous", override_id: null, active: true, amount_cents: 1800 },
  ],
  staffing_snapshot: [
    { staffing_sf_id: "S-billy-roots", opportunity_sf_id: "E-roots", opportunity_name: "(NM) Roots 2026", event_date: "2026-10-15", venue_city: "Santa Fe", venue_state: "NM", contact_sf_id: "C_billy", role: "Photographer", stage: "Booked" },
    { staffing_sf_id: "S-steph-roots", opportunity_sf_id: "E-roots", opportunity_name: "(NM) Roots 2026", event_date: "2026-10-15", venue_city: "Santa Fe", venue_state: "NM", contact_sf_id: "C_steph", role: "Print", stage: "Booked" },
    { staffing_sf_id: "S-x-lost", opportunity_sf_id: "E-lost", opportunity_name: "Lost Gala", event_date: "2026-10-16", venue_city: "Oakland", venue_state: "CA", contact_sf_id: "C_billy", role: "Photographer", stage: "Closed Lost" },
  ],
};

function parseFilters(u: URL) {
  const out: ((r: Row) => boolean)[] = [];
  for (const [k, v] of u.searchParams) {
    if (["select", "order", "limit", "columns"].includes(k)) continue;
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    out.push((r) => {
      const x = r[k];
      if (op === "eq") return String(x) === val;
      if (op === "neq") return String(x) !== val;
      if (op === "gte") return String(x) >= val;
      if (op === "lte") return String(x) <= val;
      if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")).includes(String(x));
      if (op === "not" && val === "is.null") return x !== null && x !== undefined;
      throw new Error("filter op " + op);
    });
  }
  return out;
}
const respond = (b: unknown, req: Request) => {
  const single = (req.headers.get("Accept") || "").includes("vnd.pgrst.object");
  const body = single && Array.isArray(b) ? (b[0] ?? null) : b;
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

const rampPages = [
  { data: [
    { id: "r-old", amount: 52.5, user_transaction_time: "2026-10-10T18:00:00Z", merchant_name: "Hilton", memo: "Roots hotel", card_holder: { user_id: "u-billy", first_name: "William", last_name: "Cole" }, state: "CLEARED", receipts: [] },
    { id: "r-guess", amount: 18, user_transaction_time: "2026-10-12T18:00:00Z", merchant_name: "Uber", memo: "Airport to hotel, Roots", card_holder: { user_id: "u-billy" }, state: "CLEARED", receipts: ["x"] },
    { id: "r-new1", amount: 23.45, user_transaction_time: "2026-10-15T02:30:00Z", merchant_name: "Chipotle", memo: "Per diem Roots", card_holder: { user_id: "u-billy", first_name: "William", last_name: "Cole" }, state: "PENDING", sk_category_name: "Restaurants", receipts: [] },
  ], page: { next: "https://api.ramp.com/developer/v1/transactions?start=abc" } },
  { data: [
    { id: "r-new2", amount: 301, user_transaction_time: "2026-10-01T18:00:00Z", merchant_name: "Southwest", memo: "Flights for Billy and Steph, Roots", card_holder: { user_id: "u-japhy" }, state: "CLEARED", receipts: [] },
    { id: "r-new3", amount: 20, user_transaction_time: "2026-10-14T18:00:00Z", merchant_name: "Anthropic", memo: "Claude subscription", card_holder: { user_id: "u-japhy" }, state: "CLEARED" },
    { id: "r-new4", amount: 9.99, user_transaction_time: "2026-10-14T18:00:00Z", merchant_name: "Mystery Co", memo: null, card_holder: { user_id: "u-japhy" }, state: "CLEARED" },
    { id: "r-new5", amount: 40, user_transaction_time: "2026-10-14T18:00:00Z", merchant_name: "Bad Guess Inc", memo: "x", card_holder: { user_id: "u-billy" }, state: "CLEARED" },
    { id: "r-declined", amount: 99, user_transaction_time: "2026-10-14T18:00:00Z", merchant_name: "Nope", state: "DECLINED" },
  ], page: { next: null } },
];
let claudeCalls: Row[] = [];
const rampCalls: string[] = [];

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const u = new URL(req.url);
  if (u.host === "api.ramp.com") {
    rampCalls.push(req.url);
    if (u.pathname.endsWith("/token")) return new Response(JSON.stringify({ access_token: "ramp-tok" }));
    return new Response(JSON.stringify(u.searchParams.get("start") ? rampPages[1] : rampPages[0]));
  }
  if (u.host === "api.anthropic.com") {
    const b = JSON.parse(await req.text()); claudeCalls.push(b);
    const ids = [...b.messages[0].content.matchAll(/"charge_id":"([^"]+)"/g)].map((m: RegExpMatchArray) => m[1]);
    const lineOf = (ext: string) => T.expense_line.find((l) => l.external_id === ext)?.id;
    const pl = ids.map((id: string) => {
      const ext = T.expense_line.find((l) => l.id === id)?.external_id;
      if (ext === "r-new1") return { charge_id: id, decision: "event", opportunity_sf_id: "E-roots", staffing_sf_ids: ["S-billy-roots"], category: "per_diem", fine_category: "meals", confidence: "high", reason: "Memo says per diem for Roots; Billy is on the crew." };
      if (ext === "r-new2") return { charge_id: id, decision: "event", opportunity_sf_id: "E-roots", staffing_sf_ids: ["S-billy-roots", "S-steph-roots"], category: "flights", fine_category: "flights", confidence: "high", reason: "Memo names Billy and Steph for Roots." };
      if (ext === "r-new3") return { charge_id: id, decision: "overhead", confidence: "high", reason: "Software subscription." };
      if (ext === "r-guess") return { charge_id: id, decision: "event", opportunity_sf_id: "E-roots", staffing_sf_ids: ["S-billy-roots"], category: "transportation", fine_category: "rideshare", confidence: "high", reason: "Memo now names Roots." };
      if (ext === "r-new5") return { charge_id: id, decision: "event", opportunity_sf_id: "E-roots", staffing_sf_ids: ["S-not-on-crew"], category: "other", confidence: "high", reason: "Made-up staff id." };
      return { charge_id: id, decision: "unknown", confidence: "low", reason: "No memo and no matching crew." };
    });
    void lineOf;
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_placements", input: { placements: pl } }] }));
  }
  if (u.host === "db.test") {
    if (u.pathname.startsWith("/rest/v1/rpc/app_me")) {
      const auth = req.headers.get("Authorization") || "";
      return respond([{ email: "kiki@thevanityportraitstudio.com", is_member: auth.includes("member"), is_editor: false }], req);
    }
    const table = u.pathname.replace("/rest/v1/", "");
    const rows = (T[table] ||= []);
    const filters = parseFilters(u);
    const hit = (r: Row) => filters.every((f) => f(r));
    if (req.method === "GET") {
      let out = rows.filter(hit);
      const order = u.searchParams.get("order");
      if (order) { const [c, d] = order.split("."); out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (d === "desc" ? -1 : 1)); }
      const lim = u.searchParams.get("limit"); if (lim) out = out.slice(0, +lim);
      return respond(out, req);
    }
    if (req.method === "POST") {
      const b = JSON.parse(await req.text());
      const arr = (Array.isArray(b) ? b : [b]).map((r: Row) => ({ id: r.id ?? `${table}-${++seq}`, active: table === "allocation_current" ? true : undefined, started_at: new Date().toISOString(), ...r }));
      rows.push(...arr);
      return respond(arr, req);
    }
    if (req.method === "PATCH") {
      const b = JSON.parse(await req.text());
      const out = rows.filter(hit); out.forEach((r) => Object.assign(r, b));
      return respond(out, req);
    }
  }
  throw new Error("unmocked " + req.method + " " + req.url);
}) as typeof fetch;

const { handler } = await import("./index.ts");
let failed = 0;
const assert = (c: boolean, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) failed++; };
const call = (headers: Record<string, string>, body: unknown = {}) =>
  handler(new Request("https://fn/ramp-sync", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));

// 1. auth
assert((await call({})).status === 401, "no sign-in -> 401");
assert((await call({ Authorization: "Bearer outsider" })).status === 403, "non-TVPS account -> 403");

// 2. not connected
let j = await (await call({ Authorization: "Bearer member" })).json();
assert(j.status === "not_connected", "no Ramp keys -> not_connected, nothing pulled");
assert(rampCalls.length === 0, "Ramp not called without keys");

// 3. full run
Deno.env.set("RAMP_CLIENT_ID", "id"); Deno.env.set("RAMP_CLIENT_SECRET", "sec"); Deno.env.set("ANTHROPIC_API_KEY", "sk");
j = await (await call({ Authorization: "Bearer member" })).json();
console.log(j.message);
assert(j.status === "ok" && j.categorized === 6, "run ok, 6 categorized");
assert(rampCalls.some((u) => u.includes("start=abc")), "followed Ramp page.next");
assert(rampCalls.some((u) => u.includes("from_date=2026-09-21")), "window = last charge date (12 Oct) minus 21 days");
assert(j.fetched === 7 && j.new_lines === 5, "7 usable charges (declined skipped), 5 new");
const line = (ext: string) => T.expense_line.find((l) => l.external_id === ext)!;
const active = (ext: string) => T.allocation_current.filter((a) => a.expense_line_id === line(ext).id && a.active);
assert(!line("r-declined"), "declined charge not stored");
assert(line("r-new1").txn_date === "2026-10-15" && line("r-new1").state === "pending" && line("r-new1").payer_name === "Billy Cole", "new line: UTC date, pending state, payer mapped by Ramp user id");
const n1 = active("r-new1");
assert(n1.length === 1 && n1[0].status === "suggested" && n1[0].staffing_sf_id === "S-billy-roots" && n1[0].confidence === "high", "per diem suggested on Billy / Roots, green");
const n2 = active("r-new2");
assert(n2.length === 2 && n2.reduce((s, a) => s + (a.amount_cents as number), 0) === 30100 && n2[0].amount_cents === 15050, "flights split across Billy + Steph to the cent");
assert(active("r-new3")[0].status === "overhead" && line("r-new3").intent === "overhead", "subscription -> overhead");
assert(active("r-new4")[0].status === "held" && active("r-new4")[0].confidence === "low", "unknown -> held, red");
const n5 = active("r-new5")[0];
assert(n5.status === "held" && n5.opportunity_sf_id === "E-roots" && n5.staffing_sf_id === null, "staff not on crew -> held with event kept as a hint");
assert(line("r-old").memo === "Roots hotel" && line("r-old").amount_cents === 5250 && line("r-old").state === "cleared", "existing line refreshed: memo, amount, pending->cleared");
assert(active("r-old").length === 1 && active("r-old")[0].id === "A-old", "person-placed charge NOT re-guessed");
assert(/Hilton changed to \$52.50/.test(j.message), "amount change on a placed charge is reported");
const g = active("r-guess");
assert(g.length === 1 && g[0].status === "suggested" && g[0].sf_category === "transportation", "auto-guessed charge re-guessed after its memo arrived");
assert(T.allocation_current.find((a) => a.id === "A-guess")!.active === false, "old guess deactivated, not deleted");
const prompt = String((claudeCalls[0].messages as Row[])[0].content);
assert(!prompt.includes("Lost Gala"), "Closed Lost events never shown to Claude");
assert(claudeCalls[0].model === "claude-sonnet-5-5" && (claudeCalls[0].tool_choice as Row).name === "record_placements", "forced tool use on the configured model");
const run = T.ramp_sync_run.at(-1)!;
assert(run.status === "ok" && run.triggered_by === "kiki@thevanityportraitstudio.com", "run logged with who pressed Sync");

// 4. second run: nothing new
claudeCalls = [];
j = await (await call({ "x-cron-key": "k" })).json();
assert(j.new_lines === 0 && claudeCalls.length === 0, "re-run is idempotent: no new lines, no Claude call");

// 5. Claude down: charges still land (held) and get picked up next time
Deno.env.delete("ANTHROPIC_API_KEY");
rampPages[1].data.push({ id: "r-new6", amount: 12, user_transaction_time: "2026-10-16T18:00:00Z", merchant_name: "Starbucks", memo: "Per diem Roots", card_holder: { user_id: "u-billy" }, state: "CLEARED" } as never);
j = await (await call({ "x-cron-key": "k" })).json();
assert(j.new_lines === 1 && active("r-new6")[0].basis === "pending_claude" && j.status === "partial", "no Claude key -> new charge held as pending_claude, run partial");
Deno.env.set("ANTHROPIC_API_KEY", "sk");
j = await (await call({ "x-cron-key": "k" })).json();
assert(active("r-new6").length === 1 && active("r-new6")[0].basis !== "pending_claude", "next run with Claude categorizes the waiting charge");

console.log(failed ? `\n${failed} FAILED` : "\nALL RAMP-SYNC TESTS PASSED");
if (failed) Deno.exit(1);
