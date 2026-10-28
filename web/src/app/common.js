import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import htm from "htm";
import { createClient } from "@supabase/supabase-js";

const parseStyle = (str) => Object.fromEntries(str.split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
  const i = x.indexOf(":");
  return [x.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()), x.slice(i + 1).trim()];
}));
const ATTR = { class: "className", colspan: "colSpan", rowspan: "rowSpan", "stroke-width": "strokeWidth", "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin", "aria-label": "aria-label" };
const h = (type, props, ...children) => {
  if (props) {
    const p = {};
    for (const [k, v] of Object.entries(props)) p[ATTR[k] || k] = k === "style" && typeof v == "string" ? parseStyle(v) : v;
    props = p;
  }
  return React.createElement(type, props, ...children);
};
const html = htm.bind(h);

const SUPABASE_URL = "https://apzwwfuvoggiyfzgazdp.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwend3ZnV2b2dnaXlmemdhemRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MzUyMzUsImV4cCI6MjEwNTQxMTIzNX0.sUVEqLGu_Ck7SS6ydYCU1qH1AvSRrW9-XElH91OpTaw";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
const SYNC_URL = SUPABASE_URL + "/functions/v1/sf-sync";
const RAMP_SYNC_URL = SUPABASE_URL + "/functions/v1/ramp-sync";
const WAGE_SYNC_URL = SUPABASE_URL + "/functions/v1/wage-sync";
const SYNC_FROM = "2026-09-07"; // events before this are pre-tool and never sync

const CATS = ["flights", "baggage", "hotels", "transportation", "per_diem", "other", "mileage"];
const CAT_LABEL = { flights: "Flights", baggage: "Baggage", hotels: "Hotels", transportation: "Transportation", per_diem: "Per Diem", other: "Other", mileage: "Mileage" };
const CAT_SHORT = { flights: "Flights", baggage: "Bags", hotels: "Hotels", transportation: "Transport", per_diem: "Per Diem", other: "Other", mileage: "Mileage" };
const CAT_HINT = { flights: "Airfare", baggage: "Checked-bag fees", hotels: "Rooms", transportation: "Rental car, fuel, Uber, Lyft, parking, tolls", per_diem: "Meals while travelling", other: "Carts, wifi, anything else for the event", mileage: "Personal-car miles at $0.76" };
const SF_FIELD_LABEL = { flights: "Travel Expense – Flights", baggage: "Travel Expense – Baggage Fees", hotels: "Travel Expense – Hotels", transportation: "Travel Expense – Transportation", per_diem: "Travel Expense – Per Diem", other: "Travel Expense – Other", mileage: "Mileage Reimbursement" };
// best-guess Salesforce bucket from the finer category the matcher stored
const FINE_TO_CAT = { flights: "flights", baggage: "baggage", hotels: "hotels", rental_car: "transportation", parking: "transportation", tolls: "transportation", rideshare: "transportation", taxi: "transportation", fuel: "transportation", per_diem: "per_diem", meals: "per_diem", groceries: "per_diem", mileage: "mileage", wifi_inflight: "other", carts: "other", supplies: "other", other: "other" };
const guessCat = (l) => l.sf_category || FINE_TO_CAT[l.fine_category] || "other";

const WAGE_FIELD_LABEL = { on_site_hours: "On-Site Hours", on_site_wages: "On-Site Wages", commute_hours: "Commuting Hours", commute_wages: "Commuting Wages" };
const hrs = (h) => h == null ? "—" : Number(h).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + " h";

const $ = (c) => c == null ? "—" : (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $0 = (c) => c ? $(c) : "";
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "no date";
const fmtShort = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
const fmtWhen = (ts) => ts ? new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return t.toISOString().slice(0, 10); };
const place = (e) => [e.venue_city, e.venue_state].filter(Boolean).join(", ");

const STATUS = {
  written: { cls: "ok", label: "In Salesforce", help: "Already in the staffing record in Salesforce." },
  proposed: { cls: "info", label: "Will sync", help: "Goes to Salesforce on the next sync (daily at 6am, or Sync all)." },
  pending: { cls: "warn", label: "Pending charge", help: "The card charge hasn't cleared, so its amount can still change. It syncs once it clears." },
  held: { cls: "held", label: "Not added", help: "Not added to an event yet. Place it on the Expenses tab." },
  suggested: { cls: "held", label: "Best guess", help: "The app's guess, not added to the event yet. It doesn't count until someone presses Add to event." },
  overhead: { cls: "grey", label: "Overhead", help: "Not an event cost." },
  historical: { cls: "grey", label: "Pre-tool · records only", help: "Bought before the tool started writing to Salesforce, so Salesforce was keyed by hand. Moving it here corrects the app's records but never changes Salesforce, so it can't be counted twice." },
  pretool: { cls: "grey", label: "Pre-tool event", help: "Event is before 7 Sep, when the tool started. Changes are kept here but don't sync to Salesforce." },
};
// one status per placement, decided explicitly (no fall-through label)
// `queued` = set of "staffing|category" the next sync will change; a proposed line whose field
// isn't queued already matches Salesforce (e.g. removed and added back), so it reads "In Salesforce".
function lineStatus(l, queued) {
  if (l.status === "held") return "held";
  if (l.status === "suggested") return "suggested";
  if (l.status === "overhead") return "overhead";
  if (l.status === "historical") return "historical";
  if (l.in_salesforce || l.status === "written") return "written";
  if (l.status === "proposed") {
    if (l.record_event_date && l.record_event_date < SYNC_FROM) return "pretool";
    if (l.clear_state === "pending") return "pending";
    if (queued && !queued.has(l.staffing_sf_id + "|" + l.sf_category)) return "written";
    return "proposed";
  }
  return l.status;
}

const BASIS = {
  "matcher:v7": "Matched on memo, date and crew.",
  memo_explicit: "The memo names the event and the payer is on the crew.",
  "rule:first_day": "Multi-day trip: all costs sit on the first day's record.",
  "rule:named_people_split": "The memo names specific people, so it was split between exactly them.",
  needs_person: "The memo names the event but not who it was for.",
  needs_event: "The memo does not say which event.",
  needs_both: "The memo names neither the event nor a person.",
  no_memo: "No memo on the charge.",
  no_match: "No event near this date for this person.",
  override: "Placed by hand in this app.",
  "date+crew": "Placed by date and who was staffed that day.",
  "intent:overhead": "The memo reads as overhead.",
  "intent:ambiguous": "Could be overhead or an event cost.",
  pending_claude: "Waiting for Claude to suggest a placement.",
};
const basisText = (b) => BASIS[b] || (b && b.startsWith("colson_decision") ? "Colson's call on " + b.slice(16) : b || "");

const Icon = {
  search: () => html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  info: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-linecap="round"/></svg>`,
  chev: () => html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
  check: () => html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`,
  sync: () => html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8"/><path d="M21 4v5h-5M3 20v-5h5"/></svg>`,
};

// Supabase answers at most 1000 rows per request, so the big views are read a page at a time.
const PAGE = 1000;
async function all(table, order) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select("*");
    if (order) q = q.order(order.col, { ascending: !order.desc });
    if (order?.then) q = q.order(order.then, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

async function loadAll() {
  const [events, lines, crew, recon, syncQueue, syncFlags, sr, rr,
         wageShifts, wageRecords, wageRates, wf, wr, timesheetIssues, missingTimesheets, reviewBonuses, tipShares, contractorInvoices, contractorLines] = await Promise.all([
    all("v_app_event", { col: "event_date", desc: true, then: "opportunity_sf_id" }),
    all("v_app_line", { col: "allocation_id" }),
    all("v_app_crew", { col: "staffing_sf_id" }),
    all("v_app_reconciliation", { col: "staffing_sf_id", then: "sf_category" }),
    all("v_app_sync_queue", { col: "staffing_sf_id", then: "sf_category" }),
    all("v_app_sync_flag", { col: "id" }),
    sb.from("sf_sync_run").select("*").order("started_at", { ascending: false }).limit(15),
    sb.from("ramp_sync_run").select("*").order("started_at", { ascending: false }).limit(5),
    all("v_app_wage_shift", { col: "work_date", then: "person_name" }),
    all("v_app_wage_record", { col: "staffing_sf_id" }),
    all("v_app_wage_rate", { col: "person_name" }),
    sb.from("wage_sync_flag").select("*").is("resolved_at", null).order("created_at", { ascending: false }),
    sb.from("wage_sync_run").select("*").order("started_at", { ascending: false }).limit(15),
    all("v_app_timesheet_issue", { col: "issue_key" }),
    all("v_app_missing_timesheet", { col: "event_date" }),
    all("v_app_review_bonus", { col: "event_date" }),
    all("v_app_tip_share", { col: "event_date" }),
    all("v_app_contractor_invoice", { col: "invoice_date", desc: true, then: "invoice_id" }),
    all("v_app_contractor_line", { col: "invoice_id", then: "line_no" }),
  ]);
  if (sr.error) throw sr.error;
  return {
    events, lines, crew, recon, syncQueue, syncFlags,
    syncRuns: sr.data, rampRuns: rr.error ? [] : rr.data,
    wageShifts, wageRecords, wageRates,
    wageFlags: wf.error ? [] : wf.data,
    wageRuns: wr.error ? [] : wr.data,
    timesheetIssues, missingTimesheets, reviewBonuses, tipShares, contractorInvoices, contractorLines,
    // one entry per staffing record with a timesheet problem (drives the Wages tab badge)
    wageRateFlags: [...new Set(timesheetIssues.filter((i) => i.audience === "employee").map((i) => i.staffing_sf_id))],
  };
}

// Every edit is an override row; the database places the charge and keeps the history.
async function saveOverride(user, payload) {
  const { error } = await sb.from("allocation_override").insert({ decided_by: user.email, ...payload });
  if (error) throw error;
}

// Pull the latest card charges from Ramp; Claude pre-fills a best guess for each new one.
async function runRampSync() {
  const { data } = await sb.auth.getSession();
  const r = await fetch(RAMP_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session?.access_token, apikey: SUPABASE_ANON },
    body: "{}",
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok && !b.status) throw new Error(b.error || "Ramp sync failed (" + r.status + ")");
  return b;
}
// Setting a role on a shift is an override row; the database re-prices it and keeps the history.
async function saveWageRole(user, payload) {
  const { error } = await sb.from("wage_role_override").insert({ decided_by: user.email, ...payload });
  if (error) throw error;
}

// Ask for reminder emails. Claude drafts them in Colson's Gmail for review; nothing sends itself.
async function requestReminders(user, rows) {
  const { error } = await sb.from("timesheet_reminder").insert(rows.map((r) => ({
    contact_sf_id: r.contact_sf_id, event_date: r.event_date, what: r.what, requested_by: user.email })));
  if (error) throw error;
}

// Record that a review bonus or tip share went through payroll.
async function markExtraPaid(user, kind, rows) {
  const { error } = await sb.from("payroll_extra_paid").insert(rows.map((r) => ({
    kind, opportunity_sf_id: r.opportunity_sf_id, contact_sf_id: r.contact_sf_id, amount_cents: r.amount_cents, marked_by: user.email })));
  if (error) throw error;
}

// Tick or untick a wage record for the next Salesforce sync. Latest choice wins.
async function setWageSyncChoice(user, staffingIds, sync) {
  const { error } = await sb.from("wage_sync_choice").insert(staffingIds.map((id) => ({
    staffing_sf_id: id, sync, decided_by: user.email })));
  if (error) throw error;
}

// Ignore a "Timesheet not entered properly" line: the time was checked and is right. ignored=false undoes it.
async function ignoreTimesheetIssues(user, issues, ignored = true) {
  const { error } = await sb.from("timesheet_issue_ignore").insert(issues.map((i) => ({
    issue_key: i.issue_key, ignored, staffing_sf_id: i.staffing_sf_id, wage_shift_id: i.wage_shift_id || null, reason: i.reason, decided_by: user.email })));
  if (error) throw error;
}

// Contractor invoices: fix a line's staffing record / Day 1 record, or approve the invoice for the wage sync.
async function setContractorLine(lineId, staffingId, targetId) {
  const { error } = await sb.rpc("contractor_line_set", { p_line: lineId, p_staffing: staffingId, p_target: targetId });
  if (error) throw error;
}
async function setContractorInvoiceStatus(invoiceId, status) {
  const { error } = await sb.rpc("contractor_invoice_set_status", { p_invoice: invoiceId, p_status: status });
  if (error) throw error;
}

async function runWageSync(dryRun = false) {
  const { data } = await sb.auth.getSession();
  const r = await fetch(WAGE_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session?.access_token, apikey: SUPABASE_ANON },
    body: JSON.stringify({ dry_run: dryRun }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok && !b.status) throw new Error(b.error || "Wage sync failed (" + r.status + ")");
  return b;
}

// Anyone signed in with a TVPS email can pull charges and categorize them (Colson, 22 Oct).
const canEdit = (u) => !!(u?.is_member || u?.is_editor);

async function runSync(dryRun = false) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  const r = await fetch(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, apikey: SUPABASE_ANON },
    body: JSON.stringify({ dry_run: dryRun }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok && !b.status) throw new Error(b.error || "Sync failed (" + r.status + ")");
  return b;
}

const isPast = (e, cutoff) => !!e.event_date && e.event_date < cutoff;
const Badge = ({ s }) => {
  const m = STATUS[s] || { cls: "grey", label: s };
  return html`<span class="badge ${m.cls}" title=${m.help || ""}><span class="dot"></span>${m.label}</span>`;
};
const Src = ({ s }) => html`<span class="src ${(s || "").replace(" ", "")}" title=${"Charge came from " + s}>${s}</span>`;
const Help = ({ children }) => html`<div class="help"><${Icon.info}/><div>${children}</div></div>`;

// Budget = what the client was billed, no buffer (Colson, 20 Oct).
function tileState(x) {
  if (x.billed && x.spent > x.billed) return { cls: "bad", text: `Over by ${$(x.spent - x.billed)}` };
  if (!x.billed && x.spent) return { cls: "unb", text: "Spent, nothing billed" };
  if (!x.spent && !x.billed) return { cls: "idle", text: "Nothing yet" };
  return { cls: "ok", text: `${$(x.billed - x.spent)} left` };
}

function eventStatusWords(e) {
  const out = [];
  const over = Object.entries(e.categories || {}).filter(([, x]) => x.billed > 0 && x.spent > x.billed).map(([k]) => CAT_LABEL[k]);
  if (over.length) out.push(html`<span class="bad" key="o">Over budget: ${over.join(", ")}</span>`);
  if (e.held_lines > 0) out.push(html`<span class="held" key="h">${e.held_lines} waiting to be added</span>`);
  if (e.proposed_lines > 0) out.push(html`<span class="info" key="p">${e.proposed_lines} waiting to sync</span>`);
  if (!out.length && e.spent_cents > 0) out.push(html`<span class="ok" key="k">All placed, within budget</span>`);
  if (!out.length) out.push(html`<span class="mute" key="n">No charges yet</span>`);
  return out;
}

export {
  $, $0, BASIS, Badge, CATS, CAT_HINT, CAT_LABEL, CAT_SHORT, FINE_TO_CAT, Help, Icon, React, SF_FIELD_LABEL, STATUS, SYNC_FROM, Src,
  basisText, daysAgoISO, eventStatusWords, fmtDate, fmtShort, fmtWhen, guessCat, html, isPast, lineStatus, loadAll, place,
  runSync, runRampSync, canEdit, saveOverride, sb, tileState, todayISO, useCallback, useEffect, useMemo, useRef, useState,
  WAGE_FIELD_LABEL, hrs, saveWageRole, runWageSync, requestReminders, markExtraPaid, setWageSyncChoice, ignoreTimesheetIssues, setContractorLine, setContractorInvoiceStatus,
};
