// In-memory stand-in for Supabase, mirroring what the database triggers do with overrides.
const SYNC_FROM = "2026-09-07";
const crew = [
  { staffing_sf_id: "S1", opportunity_sf_id: "E1", contact_sf_id: "C_billy", full_name: "Billy Cole", role: "Photographer", event_date: "2026-10-10", is_ops_buyer: false, sf_total_cents: 65560, sf_mileage_cents: 0, fetched_at: "2026-10-13T21:00:00Z" },
  { staffing_sf_id: "S2", opportunity_sf_id: "E1", contact_sf_id: "C_kiki", full_name: "Kiki Dickie", role: "Assistant", event_date: "2026-10-10", is_ops_buyer: false, sf_total_cents: 0, sf_mileage_cents: 0, fetched_at: "2026-10-13T21:00:00Z" },
  { staffing_sf_id: "S3", opportunity_sf_id: "E1", contact_sf_id: "C_steph", full_name: "Stephanie Walker", role: "Print Manager", event_date: "2026-10-10", is_ops_buyer: false, sf_total_cents: 0, sf_mileage_cents: 0, fetched_at: "2026-10-13T21:00:00Z" },
  { staffing_sf_id: "S4", opportunity_sf_id: "E2", contact_sf_id: "C_steph", full_name: "Stephanie Walker", role: "Photographer", event_date: "2026-10-08", is_ops_buyer: false, sf_total_cents: 4200, sf_mileage_cents: 0, fetched_at: "2026-10-13T21:00:00Z" },
  { staffing_sf_id: "S6", opportunity_sf_id: "E4", contact_sf_id: "C_billy", full_name: "Billy Cole", role: "Photographer", event_date: "2026-09-30", is_ops_buyer: false, sf_total_cents: 0, sf_mileage_cents: 0, fetched_at: "2026-10-13T21:00:00Z" },
  { staffing_sf_id: "S5", opportunity_sf_id: "E3", contact_sf_id: "C_billy", full_name: "Billy Cole", role: "Photographer", event_date: "2026-05-01", is_ops_buyer: false, sf_total_cents: 10000, sf_mileage_cents: 0, fetched_at: "2026-10-13T21:00:00Z" },
];
const people = { C_billy: "Billy Cole", C_kiki: "Kiki Dickie", C_steph: "Stephanie Walker", C_japhy: "Japhy Altenhein" };
const baseEvents = [
  { opportunity_sf_id: "E1", opportunity_name: "(NM) EP - HRTG - Roots 2026 Day 1", event_date: "2026-10-10", venue_city: "Santa Fe", venue_state: "NM", stage: "Photos Delivered", staffing_records: 3, billed_travel_fee_cents: 25000,
    billed: { flights: 100000, hotels: 50000, transportation: 20000, per_diem: 30000 } },
  { opportunity_sf_id: "E2", opportunity_name: "Edward's 50th Birthday Bash", event_date: "2026-10-08", venue_city: "San Francisco", venue_state: "CA", stage: "Photos Delivered", staffing_records: 1, billed_travel_fee_cents: 0, billed: {} },
  { opportunity_sf_id: "E4", opportunity_name: "Lost Gala (closed lost)", event_date: "2026-09-30", venue_city: "Oakland", venue_state: "CA", stage: "Closed Lost", staffing_records: 1, billed_travel_fee_cents: 0, billed: {} },
  { opportunity_sf_id: "E3", opportunity_name: "Old Spring Gala", event_date: "2026-05-01", venue_city: "Oakland", venue_state: "CA", stage: "Photos Delivered", staffing_records: 1, billed_travel_fee_cents: 0, billed: {} },
];
let seq = 100;
const mk = (o) => ({
  allocation_id: "A" + (seq++), status: "proposed", basis: "matcher:v7", note: null, source: "Ramp", clear_state: "cleared",
  payer_is_ops_buyer: false, in_salesforce: false, memo: "", fine_category: null, ...o,
});
const lineInfo = {
  L1: { expense_line_id: "L1", line_cents: 65560, charge_date: "2026-05-29", merchant_name: "Southwest", memo: "Flight for William Cr Cole OAK-ABQ-OAK", payer_contact_sf_id: "C_japhy", payer_full_name: "Japhy Altenhein", payer_is_ops_buyer: true, fine_category: "flights" },
  L2: { expense_line_id: "L2", line_cents: 31915, charge_date: "2026-10-09", merchant_name: "Hilton Santa Fe", memo: "Hotel for Roots crew", payer_contact_sf_id: "C_japhy", payer_full_name: "Japhy Altenhein", payer_is_ops_buyer: true, fine_category: "hotels" },
  L3: { expense_line_id: "L3", line_cents: 2345, charge_date: "2026-10-10", merchant_name: "Chipotle", memo: "Lunch Roots", payer_contact_sf_id: "C_steph", payer_full_name: "Stephanie Walker", clear_state: "pending", fine_category: "meals" },
  L4: { expense_line_id: "L4", line_cents: 4000, charge_date: "2026-10-10", merchant_name: "Uber", memo: "Airport to hotel", payer_contact_sf_id: "C_kiki", payer_full_name: "Kiki Dickie", fine_category: "rideshare" },
  L5: { expense_line_id: "L5", line_cents: 6866, charge_date: "2026-09-28", merchant_name: "Doordash", memo: "", payer_contact_sf_id: "C_billy", payer_full_name: "Billy Cole", fine_category: "meals" },
  L7: { expense_line_id: "L7", line_cents: 2070, charge_date: "2026-10-11", merchant_name: "Drip Drop Coffee", memo: "Breakfast Day 2 Roots", payer_contact_sf_id: "C_kiki", payer_full_name: "Kiki Dickie", fine_category: "per_diem", source: "Gusto" },
  L6: { expense_line_id: "L6", line_cents: 10000, charge_date: "2026-04-30", merchant_name: "Costco", memo: "Snacks", payer_contact_sf_id: "C_billy", payer_full_name: "Billy Cole", fine_category: "groceries" },
};
let rows = [
  mk({ ...lineInfo.L1, opportunity_sf_id: "E1", staffing_sf_id: "S1", sf_category: "flights", status: "written", in_salesforce: true }),
  mk({ ...lineInfo.L2, opportunity_sf_id: "E1", staffing_sf_id: null, sf_category: null, status: "held", basis: "needs_person", confidence: "low", confidence_reason: "Memo names Roots but not who the rooms were for." }),
  mk({ ...lineInfo.L3, opportunity_sf_id: "E1", staffing_sf_id: "S3", sf_category: "per_diem" }),
  mk({ ...lineInfo.L4, opportunity_sf_id: "E1", staffing_sf_id: "S2", sf_category: "transportation" }),
  mk({ ...lineInfo.L5, opportunity_sf_id: null, staffing_sf_id: null, sf_category: null, status: "held", basis: "no_memo" }),
  mk({ ...lineInfo.L7, opportunity_sf_id: "E1", staffing_sf_id: "S2", sf_category: "per_diem", status: "suggested", confidence: "high", confidence_reason: "Memo names the event and the card holder is on the crew that day." }),
  mk({ ...lineInfo.L6, opportunity_sf_id: "E3", staffing_sf_id: "S5", sf_category: "other", status: "historical" }),
];
const ledger = { "S1|flights": 65560 };
let flags = [{ id: "F1", staffing_sf_id: "S4", opportunity_sf_id: "E2", sf_category: "transportation", kind: "hand_edit", sf_value_cents: 5000, expected_cents: 4200, delta_cents: 0, opportunity_name: "Edward's 50th Birthday Bash", event_date: "2026-10-08", full_name: "Stephanie Walker" }];
let rampRuns = [{ id: "RR1", trigger: "daily", triggered_by: "schedule", status: "ok", started_at: "2026-10-21T12:37:00Z", finished_at: "2026-10-21T12:38:10Z", message: "Pulled 3 charges." }];
const runs = [{ id: "R1", trigger: "daily", started_at: "2026-10-20T13:07:00Z", finished_at: "2026-10-20T13:07:05Z", status: "nothing_to_do", fields_written: 0, net_cents: 0, message: "Salesforce is already up to date." }];
window.__overrides = [];

const enrich = (r) => {
  const st = crew.find((c) => c.staffing_sf_id === r.staffing_sf_id);
  return { ...r, on_record_name: st?.full_name || null, record_event_date: st?.event_date || null,
    share_count: rows.filter((x) => x.expense_line_id === r.expense_line_id).length };
};
const CATS = ["flights", "baggage", "hotels", "transportation", "per_diem", "other", "mileage"];
function events() {
  return baseEvents.map((e) => {
    const mine = rows.filter((r) => r.opportunity_sf_id === e.opportunity_sf_id);
    const counted = mine.filter((r) => ["written", "proposed", "historical"].includes(r.status));
    const categories = Object.fromEntries(CATS.map((k) => [k, { billed: e.billed[k] || 0, spent: counted.filter((r) => r.sf_category === k).reduce((s, r) => s + r.allocated_cents, 0), held: 0 }]));
    return { ...e, categories,
      billed_category_cents: Object.values(e.billed).reduce((a, b) => a + b, 0),
      spent_cents: counted.reduce((s, r) => s + r.allocated_cents, 0),
      held_cents: mine.filter((r) => r.status === "held" || r.status === "suggested").reduce((s, r) => s + r.allocated_cents, 0),
      held_lines: mine.filter((r) => r.status === "held" || r.status === "suggested").length,
      proposed_lines: mine.filter((r) => r.status === "proposed").length };
  });
}
function queue() {
  const t = {};
  for (const r of rows) {
    const st = crew.find((c) => c.staffing_sf_id === r.staffing_sf_id);
    if (!st || st.event_date < SYNC_FROM || !r.sf_category) continue;
    if (!(r.status === "written" || (r.status === "proposed" && r.clear_state !== "pending"))) continue;
    const k = r.staffing_sf_id + "|" + r.sf_category; t[k] = (t[k] || 0) + r.allocated_cents;
  }
  const keys = new Set([...Object.keys(t), ...Object.keys(ledger)]);
  return [...keys].map((k) => {
    const [sid, cat] = k.split("|"); const st = crew.find((c) => c.staffing_sf_id === sid);
    const ev = baseEvents.find((e) => e.opportunity_sf_id === st.opportunity_sf_id);
    return { staffing_sf_id: sid, opportunity_sf_id: st.opportunity_sf_id, opportunity_name: ev.opportunity_name, full_name: st.full_name, event_date: st.event_date, sf_category: cat, delta_cents: (t[k] || 0) - (ledger[k] || 0), has_open_flag: false };
  }).filter((q) => q.delta_cents !== 0);
}
function applyOverride(o) {
  window.__overrides.push(o);
  const info = { ...lineInfo[o.expense_line_id] };
  const before = rows.filter((r) => r.expense_line_id === o.expense_line_id);
  rows = rows.filter((r) => r.expense_line_id !== o.expense_line_id);
  const base = { ...info, basis: "override", note: "Moved by " + o.decided_by };
  if (o.action === "reassign") {
    const st = crew.find((c) => c.staffing_sf_id === o.staffing_sf_id);
    rows.push(mk({ ...base, opportunity_sf_id: st.opportunity_sf_id, staffing_sf_id: st.staffing_sf_id, sf_category: o.sf_category, allocated_cents: info.line_cents }));
  } else if (o.action === "unassign") {
    rows.push(mk({ ...base, opportunity_sf_id: o.opportunity_sf_id, staffing_sf_id: null, sf_category: o.sf_category, status: "held", allocated_cents: info.line_cents }));
  } else if (o.action === "remove") {
    const placed = before.filter((r) => ["written", "proposed", "historical"].includes(r.status));
    if (placed.length) rows.push(...placed.map((r) => mk({ ...r, allocation_id: undefined, status: "suggested", in_salesforce: false })).map((r) => ({ ...r, allocation_id: "A" + (seq++) })));
    else rows.push(mk({ ...base, opportunity_sf_id: null, staffing_sf_id: null, sf_category: null, status: "held", allocated_cents: info.line_cents }));
  } else if (o.action === "mark_overhead") {
    rows.push(mk({ ...base, opportunity_sf_id: null, staffing_sf_id: null, sf_category: null, status: "overhead", allocated_cents: info.line_cents }));
  } else if (o.action === "split") {
    const ids = [...o.split_staffing_ids].sort(); const n = ids.length;
    const b = Math.trunc(info.line_cents / n); const rem = info.line_cents - b * n;
    ids.forEach((sid, i) => { const st = crew.find((c) => c.staffing_sf_id === sid);
      rows.push(mk({ ...base, opportunity_sf_id: st.opportunity_sf_id, staffing_sf_id: sid, sf_category: o.sf_category, allocated_cents: b + (i < rem ? 1 : 0) })); });
  } else { rows.push(...before); return { message: "unknown action" }; }
  return null;
}
rows = rows.map((r) => ({ ...r, allocated_cents: r.allocated_cents ?? r.line_cents }));

class Q {
  constructor(t) { this.t = t; this.op = "select"; }
  select() { return this; } order() { return this; } limit() { return this; } eq() { return this; } gte() { return this; }
  insert(p) { this.op = "insert"; this.p = p; return this; }
  then(res, rej) {
    try {
      if (this.op === "insert") {
        if (this.t !== "allocation_override") return res({ data: null, error: { message: "insert not allowed" } });
        const e = applyOverride(this.p); return res({ data: null, error: e });
      }
      const data = {
        v_app_event: events(), v_app_line: rows.map(enrich), v_app_crew: crew, v_app_reconciliation: [],
        v_app_sync_queue: queue(), v_app_sync_flag: flags, sf_sync_run: runs, ramp_sync_run: rampRuns,
      }[this.t];
      res({ data: data ?? [], error: null });
    } catch (e) { rej(e); }
  }
}
export function createClient() {
  const session = { access_token: "tok", user: { email: "colson@thevanityportraitstudio.com" } };
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => {}, signInWithOtp: async () => ({}),
    },
    from: (t) => new Q(t),
    rpc: async (name, args) => {
      if (name === "app_me") {
        const member = /[?&]as=member/.test(location.search);
        return { data: [{ email: member ? "kiki@thevanityportraitstudio.com" : "colson@thevanityportraitstudio.com", is_member: true, is_editor: !member, role: member ? "viewer" : "admin" }], error: null };
      }
      if (name === "sf_sync_flag_accept") { flags = flags.filter((f) => f.id !== args.p_flag); return { data: null, error: null }; }
      return { data: null, error: { message: "unknown rpc " + name } };
    },
  };
}

// e2e helper: what the ramp-sync function would do (a new charge with Claude's guess, plus a run row)
window.__mockRampSync = (who) => {
  lineInfo.L8 = { expense_line_id: "L8", line_cents: 4210, charge_date: "2026-10-12", merchant_name: "Blue Bottle", memo: "Per diem Roots day 2", payer_contact_sf_id: "C_steph", payer_full_name: "Stephanie Walker", fine_category: "meals" };
  rows.push(mk({ ...lineInfo.L8, opportunity_sf_id: "E1", staffing_sf_id: "S3", sf_category: "per_diem", status: "suggested", basis: "claude:claude-sonnet-5-5", confidence: "high", confidence_reason: "Memo says per diem for Roots; Stephanie is on the crew.", allocated_cents: 4210 }));
  rampRuns = [{ id: "RR2", trigger: "button", triggered_by: who, status: "ok", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), message: "Pulled 1 new charge." }, ...rampRuns];
};
