// Local test: mocks Supabase REST + Salesforce, imports the function, fires requests.
const calls: { url: string; method: string; body: unknown }[] = [];
let finishPayload: Record<string, unknown> | null = null;
const SF_DB: Record<string, Record<string, number | null>> = {
  a00AAAAAAAAAAAAAAA: { Travel_Expense_Flights__c: 100, Travel_Expense_Hotels__c: null, Travel_Expense_Per_Diem__c: 20,
    Travel_Expense_Baggage_Fees__c: null, Travel_Expense_Transportation__c: null, Travel_Expense_Other__c: 5,
    Mileage_Reimbursement__c: null, Travel_Expense_Total__c: 125 },
  a00BBBBBBBBBBBBBBB: { Travel_Expense_Flights__c: null, Travel_Expense_Hotels__c: 300, Travel_Expense_Per_Diem__c: null,
    Travel_Expense_Baggage_Fees__c: null, Travel_Expense_Transportation__c: 10, Travel_Expense_Other__c: null,
    Mileage_Reimbursement__c: null, Travel_Expense_Total__c: 310 },
};
const PLAN = [
  // A: add $50.00 flights (state matches) -> 150; add $12.34 per diem, no prior state -> baseline then 32.34
  { staffing_sf_id: "a00AAAAAAAAAAAAAAA", sf_category: "flights", delta_cents: 5000, target_cents: 15000, ledger_cents: 10000, last_value_cents: 10000, has_state: true, has_open_flag: false },
  { staffing_sf_id: "a00AAAAAAAAAAAAAAA", sf_category: "per_diem", delta_cents: 1234, target_cents: 1234, ledger_cents: 0, last_value_cents: null, has_state: false, has_open_flag: false },
  // A other: removing $9 from a $5 field -> would go negative -> flag
  { staffing_sf_id: "a00AAAAAAAAAAAAAAA", sf_category: "other", delta_cents: -900, target_cents: 0, ledger_cents: 900, last_value_cents: 500, has_state: true, has_open_flag: false },
  // B hotels: hand edited (last 250 vs now 300) -> flag, skip
  { staffing_sf_id: "a00BBBBBBBBBBBBBBB", sf_category: "hotels", delta_cents: 4000, target_cents: 4000, ledger_cents: 0, last_value_cents: 25000, has_state: true, has_open_flag: false },
  // B mileage: add $7.60, mileage only -> no total change
  { staffing_sf_id: "a00BBBBBBBBBBBBBBB", sf_category: "mileage", delta_cents: 760, target_cents: 760, ledger_cents: 0, last_value_cents: null, has_state: false, has_open_flag: false },
  // B transportation: open flag -> ignored entirely
  { staffing_sf_id: "a00BBBBBBBBBBBBBBB", sf_category: "transportation", delta_cents: 999, target_cents: 999, ledger_cents: 0, last_value_cents: 1000, has_state: true, has_open_flag: true },
];

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = req.url; const method = req.method;
  const body = ["POST", "PATCH"].includes(method) ? await req.clone().text() : null;
  calls.push({ url, method, body });
  if (url.includes("/rest/v1/sf_sync_secret")) return ok({ value: "k" });
  if (url.includes("/rest/v1/app_config")) return ok([{ key: "sf_sync_enabled", value: true }]);
  if (url.includes("/rest/v1/sf_sync_run") && method === "GET") return ok([]);
  if (url.includes("/rest/v1/sf_sync_run") && method === "POST") return ok({ id: "run-1" });
  if (url.includes("/rest/v1/sf_sync_run")) return ok([]);
  if (url.includes("/rpc/app_me")) return ok([{ email: "colson@thevanityportraitstudio.com", is_editor: true }]);
  if (url.includes("/rpc/sf_sync_plan")) return ok(PLAN);
  if (url.includes("/rpc/sf_sync_finish")) { finishPayload = JSON.parse(body!); return ok(null); }
  if (url.includes("/oauth2/token")) return ok({ access_token: "tok", instance_url: "https://sf.test" });
  if (url.includes("/query?q=")) {
    return ok({ records: Object.entries(SF_DB).map(([Id, f]) => ({ Id, ...f })) });
  }
  if (url.includes("/composite/sobjects")) {
    const b = JSON.parse(body!);
    for (const r of b.records) { const { attributes: _a, id, ...f } = r; Object.assign(SF_DB[id], f); }
    return ok(b.records.map((r: { id: string }) => ({ id: r.id, success: true, errors: [] })));
  }
  throw new Error("unmocked " + method + " " + url);
}) as typeof fetch;

Deno.env.set("SUPABASE_URL", "https://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");
Deno.env.set("SUPABASE_ANON_KEY", "anon");


let handler: (r: Request) => Promise<Response>;
// capture Deno.serve's handler instead of opening a port
(Deno as unknown as { serve: unknown }).serve = (h: (r: Request) => Promise<Response>) => { handler = h; };
await import("./index.ts");

function assert(c: boolean, m: string) { if (!c) { console.error("FAIL:", m); Deno.exit(1); } else console.log("ok  ", m); }

// 1. not connected
let res = await handler!(new Request("https://fn/sf-sync", { method: "POST", headers: { "x-cron-key": "k" } }));
let j = await res.json();
assert(j.status === "not_connected", "no Salesforce secrets -> not_connected, nothing written");
assert(!calls.some((c) => c.url.includes("composite")), "no Salesforce write attempted");

// 2. connected
Deno.env.set("SF_DOMAIN", "https://sf.test"); Deno.env.set("SF_CLIENT_ID", "id"); Deno.env.set("SF_CLIENT_SECRET", "sec");
calls.length = 0; finishPayload = null;
res = await handler!(new Request("https://fn/sf-sync", { method: "POST", headers: { "x-cron-key": "k" } }));
j = await res.json();
console.log(j);
const A = SF_DB.a00AAAAAAAAAAAAAAA, B = SF_DB.a00BBBBBBBBBBBBBBB;
assert(A.Travel_Expense_Flights__c === 150, "flights 100 + 50 = 150");
assert(A.Travel_Expense_Per_Diem__c === 32.34, "per diem 20 + 12.34 = 32.34 (first sight, no flag)");
assert(A.Travel_Expense_Other__c === 5, "other untouched (would go negative)");
assert(A.Travel_Expense_Total__c === 187.34, "A total recomputed 150 + 32.34 + 5 = 187.34");
assert(B.Travel_Expense_Hotels__c === 300, "B hotels hand-edited -> untouched");
assert(B.Mileage_Reimbursement__c === 7.6, "B mileage 0 + 7.60");
assert(B.Travel_Expense_Total__c === 310, "B total unchanged (mileage only)");
assert(B.Travel_Expense_Transportation__c === 10, "B transportation open flag -> untouched");
const fp = finishPayload! as Record<string, unknown[]>;
assert(fp.p_written.length === 3, "3 fields logged as written");
assert(fp.p_totals.length === 1, "1 total logged");
const kinds = (fp.p_flags as { kind: string }[]).map((f) => f.kind).sort().join(",");
assert(kinds === "hand_edit,would_go_negative", "flags: hand_edit + would_go_negative");
assert(j.status === "partial", "status partial because of flags");
const patches = calls.filter((c) => c.url.includes("composite"));
assert(patches.length === 1 && JSON.parse(patches[0].body as string).allOrNone === true, "one allOrNone composite PATCH");
assert(calls.filter((c) => c.url.includes("/query?q=")).length === 2, "read before and re-read after");

// 3. non-editor button press
res = await handler!(new Request("https://fn/sf-sync", { method: "POST" }));
assert(res.status === 401, "no token -> 401");
console.log("\nALL SYNC TESTS PASSED");
