import {
  html, useState, useMemo, useEffect, sb, $, fmtDate, fmtWhen, canEdit, Help, Icon, Badge,
  WAGE_FIELD_LABEL, runWageSync, hrs, requestReminders, markExtraPaid, setWageSyncChoice, ignoreTimesheetIssues,
} from "./common.js";

const RUN_STATUS = {
  ok: { cls: "ok", label: "Synced" },
  partial: { cls: "warn", label: "Synced, with flags" },
  nothing_to_do: { cls: "grey", label: "Nothing to sync" },
  not_connected: { cls: "warn", label: "Salesforce not connected" },
  disabled: { cls: "grey", label: "Switched off" },
  failed: { cls: "bad", label: "Failed" },
  running: { cls: "info", label: "Running" },
};
const FLAG_TEXT = {
  manual_entry: "“Manually Enter Wages” is ticked on the staffing record",
  pre_existing_value: "Salesforce already holds a value this app did not write",
  hand_edit: "Changed in Salesforce by hand since the last wage sync",
  would_go_negative: "The computed figure is below zero",
  write_error: "Salesforce would not accept the write",
};
const SYNC_STATUS = {
  differs: { cls: "warn", label: "Differs from Salesforce", tip: "Salesforce holds different hours or wages. Ticked: the app's figures replace them." },
  fill_blank: { cls: "info", label: "Salesforce blank", tip: "Salesforce has nothing in these fields yet." },
  no_on_site: { cls: "bad", label: "No on-site hours", tip: "Gusto has commute or admin time for this day but no on-site shift. Get the shift entered (or its job type fixed) before syncing." },
  cant_price: { cls: "warn", label: "Can't price", tip: "No status or Hourly Rate on the Salesforce Contact." },
};

// Hours and wages that differ from Salesforce. Status is the audit; the tick decides what the next sync writes.
function Records({ records, issues, user, onChanged, onOpenEvent }) {
  const issueOf = {};
  for (const i of issues || []) if (i.audience === "employee") (issueOf[i.staffing_sf_id] ||= new Set()).add(TS_REASON[i.reason]?.label || i.reason);
  const [local, setLocal] = useState({});
  const [busy, setBusy] = useState(false);
  const sfh = (c) => c == null ? null : Number(c) / 100;
  const shown = records.filter((r) => r.sync_status !== "matches")
    .sort((a, b) => (b.event_date || "").localeCompare(a.event_date || "") || (a.person_name || "").localeCompare(b.person_name || ""));
  const hidden = records.length - shown.length;
  const tickable = (r) => r.sync_status !== "cant_price";
  const isOn = (r) => tickable(r) && (r.staffing_sf_id in local ? local[r.staffing_sf_id] : !!r.sync_selected);
  const ticked = shown.filter(isOn);
  const edit = !!user?.is_editor;
  const choose = async (rows, sync) => {
    const ids = rows.filter(tickable).map((r) => r.staffing_sf_id);
    if (!ids.length) return;
    setLocal({ ...local, ...Object.fromEntries(ids.map((id) => [id, sync])) });
    setBusy(true);
    try { await setWageSyncChoice(user, ids, sync); await onChanged(""); }
    catch (e) { await onChanged("Could not save: " + (e.message || e)); }
    finally { setBusy(false); }
  };
  const cell = (want, have, isMoney) => {
    const fmt = isMoney ? $ : hrs;
    if (want == null) return have == null ? html`<span class="mute">—</span>` : html`<span class="mute">—</span><div class="xs mute">Salesforce: ${fmt(have)}</div>`;
    const matches = have != null && Math.abs(Number(have) - Number(want)) < 0.005;
    return html`<span class=${matches ? "" : "b"}>${fmt(want)}</span>${matches ? "" : html`<div class="xs mute">Salesforce: ${have == null ? "empty" : fmt(have)}</div>`}`;
  };
  return html`<div>
    <div class="sec-h"><h3>Hours and wages to sync</h3>
      <span class="mute">${hidden ? `${hidden} record${hidden === 1 ? "" : "s"} already match Salesforce and are hidden. ` : ""}Ticked records are written by the next sync and replace what Salesforce holds. Untick any you want left alone.</span></div>
    <div class="card flush">${shown.length ? html`<table>
      <thead><tr><th>Sync</th><th>Event</th><th>Person</th><th class="money">On-site hours</th><th class="money">On-site wages</th><th class="money">Commute hours</th><th class="money">Commute wages</th><th>Status</th></tr></thead>
      <tbody>${shown.map((r) => {
        const st = SYNC_STATUS[r.sync_status] || { cls: "grey", label: r.sync_status };
        return html`<tr key=${r.staffing_sf_id}>
          <td>${tickable(r) ? html`<input type="checkbox" checked=${isOn(r)} disabled=${!edit || busy}
              title=${isOn(r) ? "Will be written to Salesforce on the next sync" : "Will be left alone"}
              onChange=${(e) => choose([r], e.target.checked)}/>` : ""}</td>
          <td><a onClick=${() => onOpenEvent(r.opportunity_sf_id)}>${r.opportunity_name}</a>
            <div class="xs mute">${fmtDate(r.event_date)}${r.is_multi_day ? html` · ${r.is_day_one ? html`<b>Day 1: carries the whole trip's wages</b>` : `day of ${r.trip_days}`}` : ""}</div></td>
          <td>${r.person_name || "(open slot)"}</td>
          <td class="money">${cell(r.on_site_hours, sfh(r.sf_on_site_hours_c), false)}</td>
          <td class="money">${cell(r.on_site_wage_cents, r.sf_on_site_wage_cents, true)}</td>
          <td class="money">${cell(r.commute_hours, sfh(r.sf_commute_hours_c), false)}</td>
          <td class="money">${cell(r.commute_wage_cents, r.sf_commute_wage_cents, true)}</td>
          <td><span class="badge ${st.cls}" title=${st.tip || ""}>${st.label}</span>${issueOf[r.staffing_sf_id] ? html`<div class="xs" style="color:var(--bad)">Timesheet: ${[...issueOf[r.staffing_sf_id]].join(", ")}</div>` : ""}${r.open_flags ? html`<div class="xs mute">${r.flag_kinds}</div>` : ""}</td>
        </tr>`;
      })}</tbody></table>
      ${edit && html`<div style="padding:12px 14px;border-top:1px solid var(--line-2);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="sm"><b>${ticked.length}</b> of ${shown.filter(tickable).length} ticked</span>
        <button class="btn sec small" disabled=${busy} onClick=${() => choose(shown, true)}>Tick all</button>
        <button class="btn sec small" disabled=${busy} onClick=${() => choose(shown, false)}>Untick all</button>
        <span class="xs mute">Nothing is written until someone presses Sync wages.</span></div>`}`
      : html`<div class="empty"><div class="t">Everything matches Salesforce.</div>${hidden ? html`<div class="sm">${hidden} record${hidden === 1 ? "" : "s"} checked.</div>` : ""}</div>`}</div>
  </div>`;
}

// Why a timesheet line can be wrong. `who` is who has to fix it.
const TS_REASON = {
  wrong_rate: { label: "Wrong job/rate in Gusto", who: "employee", cls: "bad",
    why: "The entry's Gusto rate doesn't match the work. On-site time must be entered under the role's job; commute and admin time under Admin/Commute ($25/hr). Salesforce gets the correct rate either way." },
  commute_not_eligible: { label: "Commute on a non-travel event", who: "employee", cls: "bad",
    why: "This venue is inside our territory, so there's no travel compensation unless they picked up gear at the studio or were assigned to load in. Neither is ticked on the staffing record." },
  missing_commute: { label: "Commute missing", who: "employee", cls: "warn",
    why: "The event qualifies for travel compensation, but no commute time was entered for that day." },
  one_way_commute: { label: "Only one-way commute", who: "employee", cls: "warn",
    why: "The event qualifies for travel compensation, but commute was entered only before the gig or only after it." },
  mixed_entry: { label: "Drive and gig in one entry", who: "employee", cls: "warn",
    why: "One entry runs an hour or more outside the scheduled shift on a travel-eligible event. The drive should be its own Admin/Commute entry: drive, gig, drive." },
  no_on_site: { label: "No on-site time", who: "employee", cls: "bad",
    why: "Commute or admin time was entered for the event day, but no on-site shift." },
  travel_comp_undetermined: { label: "Travel compensation not set in Salesforce", who: "admin", cls: "bad",
    why: "The Venue still says travel compensation is not yet determined, so the app can't tell whether commute should be paid. The email for this one goes to Japhy, who sets it on the Venue." },
  no_schedule: { label: "No shift times in Salesforce", who: "admin", cls: "grey",
    why: "The staffing record has no shift start or end, so on-site vs commute can't be checked against the schedule." },
};
const tz = (t) => t ? new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "";

// Timesheet not entered properly: one row per person and event, each problem on its own line with a tick box.
// Ticked lines become email requests; Claude drafts them in Colson's Gmail (one email per person per event,
// and one to Japhy for venues missing travel compensation). Nothing is sent automatically.
// A Gusto job is required on every entry. Older loads stored the rate but not the title; the only $25/hr job is Admin/Commuting.
const jobOf = (s) => s.gusto_role_title || (Number(s.rate_cents) === 2500 ? "Admin/Commuting" : s.rate_cents ? `${$(s.rate_cents)}/hr job` : "—");

function Timesheets({ issues, shifts, user, onChanged, onOpenEvent }) {
  // Record-level problems (commute missing, travel compensation not set…) aren't about one entry, so show every entry that day.
  const shiftsOf = useMemo(() => {
    const m = {};
    for (const x of shifts || []) if (x.staffing_sf_id) (m[x.staffing_sf_id] ||= []).push(x);
    for (const k in m) m[k].sort((a, b) => (a.clock_in || "").localeCompare(b.clock_in || ""));
    return m;
  }, [shifts]);
  const [sel, setSel] = useState({});
  const [reqs, setReqs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [gone, setGone] = useState({});
  const [undo, setUndo] = useState(null);
  const load = async () => {
    const { data } = await sb.from("timesheet_email_request").select("issue_key,status,requested_at,drafted_at").neq("status", "cancelled").order("requested_at", { ascending: false });
    setReqs(data || []);
  };
  useEffect(() => { load(); }, [issues]);
  const reqOf = {};
  for (const r of reqs) if (!reqOf[r.issue_key]) reqOf[r.issue_key] = r;
  const shown = issues.filter((i) => !gone[i.issue_key]);
  const groups = {};
  for (const i of shown) (groups[i.staffing_sf_id] ||= { ...i, lines: [] }).lines.push(i);
  const rows = Object.values(groups).sort((a, b) => (b.event_date || "").localeCompare(a.event_date || "") || (a.person_name || "").localeCompare(b.person_name || ""));
  const picked = shown.filter((i) => sel[i.issue_key] && !reqOf[i.issue_key]);
  const edit = canEdit(user);
  const canIgnore = !!user?.is_editor;
  const who = (i) => `${i.person_name || "(unknown)"}: ${(TS_REASON[i.reason] || { label: i.reason }).label}`;
  // Ignore = the time was checked and is right. The line leaves the list (and stops holding back the sync tick).
  const ignore = async (i, ignored = true) => {
    setErr(""); setGone({ ...gone, [i.issue_key]: ignored });
    if (ignored) { const { [i.issue_key]: _, ...rest } = sel; setSel(rest); }
    try {
      await ignoreTimesheetIssues(user, [i], ignored);
      setUndo(ignored ? i : null);
      await onChanged(ignored ? `Ignored ${who(i)}. Marked as approved and entered properly.` : `Put back ${who(i)}.`);
    } catch (e) { setGone({ ...gone, [i.issue_key]: !ignored }); setErr("Could not save: " + (e.message || e)); }
  };
  const draft = async () => {
    setBusy(true); setErr("");
    try {
      const { error } = await sb.from("timesheet_email_request").insert(picked.map((i) => ({
        issue_key: i.issue_key, staffing_sf_id: i.staffing_sf_id, opportunity_sf_id: i.opportunity_sf_id, reason: i.reason, audience: i.audience, requested_by: user.email })));
      if (error) throw error;
      setSel({}); await load();
      await onChanged(`${picked.length} email${picked.length === 1 ? "" : "s"} queued for Claude to draft in Colson's Gmail. Nothing is sent automatically.`);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const status = (i) => {
    const r = reqOf[i.issue_key];
    if (!r) return "";
    return r.status === "drafted" ? html`<span class="badge ok" style="margin-left:6px">Draft in Gmail</span>` : html`<span class="badge info" style="margin-left:6px">Email queued</span>`;
  };
  const line = (i) => {
    const r = TS_REASON[i.reason] || { label: i.reason, cls: "grey" };
    const done = !!reqOf[i.issue_key];
    return html`<div style="display:flex;gap:8px;align-items:flex-start">
      ${edit ? html`<input type="checkbox" style="margin-top:3px" disabled=${done} checked=${done || !!sel[i.issue_key]} title=${done ? "Email already requested" : "Tick to include in the next Gmail draft"}
        onChange=${(e) => setSel({ ...sel, [i.issue_key]: e.target.checked })}/>` : ""}
      <div><span class="badge ${r.cls}" title=${r.why || ""}>${r.label}</span>${status(i)}
      <div class="xs mute">${i.clock_in ? `${fmtDate(i.work_date)} ${tz(i.clock_in)}–${tz(i.clock_out)} · ${hrs(i.hours)}` : ""}
      ${i.entered_rate_cents != null && i.expected_rate_cents != null && i.entered_rate_cents !== i.expected_rate_cents ? ` · entered ${$(i.entered_rate_cents)}/hr, should be ${$(i.expected_rate_cents)}/hr` : ""}
      ${i.reason === "missing_commute" && i.commute_minutes ? ` · ${i.commute_minutes} min each way expected` : ""}
      ${i.audience === "admin" ? " · email goes to Japhy" : ""}</div>
      ${i.reason === "travel_comp_undetermined" ? html`<div class="xs" style="margin-top:2px">Nothing for ${(i.person_name || "them").split(" ")[0]} to fix: the Venue in Salesforce needs travel compensation set, so the app can tell whether their commute is paid.</div>` : ""}
      ${!i.wage_shift_id && (shiftsOf[i.staffing_sf_id] || []).length ? html`<div class="xs" style="margin-top:4px">${shiftsOf[i.staffing_sf_id].map((x) => html`<div key=${x.wage_shift_id}>
        ${fmtDate(x.work_date)} ${tz(x.clock_in)}–${tz(x.clock_out)} · ${hrs(Math.round((Number(x.minutes || 0) - Number(x.break_minutes || 0)) / 6) / 10)} · ${jobOf(x)}</div>`)}</div>` : ""}</div></div>`;
  };
  // Gusto job column: the entry's job, or every job used that day for record-level problems.
  const jobCell = (i) => {
    if (i.wage_shift_id) { const x = (shifts || []).find((y) => y.wage_shift_id === i.wage_shift_id); return x ? jobOf(x) : (i.gusto_role_title || null); }
    const jobs = [...new Set((shiftsOf[i.staffing_sf_id] || []).map(jobOf))];
    return jobs.length ? jobs.join(", ") : null;
  };
  return html`<div>
    <div class="sec-h"><h3>Timesheet not entered properly</h3><span class="mute">Fix these before payroll. Hover a reason to see why it was flagged. Tick the ones that need an email, then press Draft emails in Gmail. Press Ignore on a line once you've confirmed the time was approved and entered properly.</span></div>
    ${err && html`<div class="note red" style="margin-bottom:10px">${err}</div>`}
    <div class="card flush">${rows.length ? html`<table key="t">
      <thead><tr><th>Person</th><th>Event</th><th>What's wrong</th><th>Gusto job</th><th>Memo in Gusto</th>${canIgnore ? html`<th></th>` : ""}</tr></thead>
      <tbody>${rows.flatMap((g) => g.lines.sort((a, b) => (a.clock_in || "").localeCompare(b.clock_in || "")).map((i, n) => html`<tr key=${i.issue_key}>
        ${n === 0 ? html`<td key="p" rowSpan=${g.lines.length} style="vertical-align:top"><div class="b">${g.person_name || "(unknown)"}</div><div class="xs mute">${g.email || ""}</div></td>
        <td key="e" rowSpan=${g.lines.length} class="sm" style="vertical-align:top"><a onClick=${() => onOpenEvent(g.opportunity_sf_id)}>${g.opportunity_name}</a><div class="xs mute">${fmtDate(g.event_date)} · travel comp: ${g.travel_comp === "yes" ? "yes" : g.travel_comp === "no" ? "no" : "not set"}</div></td>` : ""}
        <td>${line(i)}</td>
        <td class="sm">${jobCell(i) || html`<span class="mute">—</span>`}</td>
        <td class="sm memo-c">${i.memo ? html`<span title="Memo from the Gusto timesheet">${i.memo}</span>` : html`<span class="mute">—</span>`}</td>
        ${canIgnore ? html`<td style="text-align:right;white-space:nowrap"><button class="btn sec small" title="Their time was approved and entered properly. Removes this line from the list."
          onClick=${() => ignore(i)}>Ignore</button></td>` : ""}</tr>`))}</tbody>
    </table>
    ${edit && html`<div key="f" style="padding:12px 14px;border-top:1px solid var(--line-2);display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="btn small" disabled=${!picked.length || busy} onClick=${draft}>${busy ? "Saving…" : `Draft emails in Gmail${picked.length ? ` (${picked.length})` : ""}`}</button>
      <span class="xs mute">One email per person per event, explaining each ticked problem and how to fix it in Gusto. Venues missing travel compensation go to Japhy in one email. Drafts only: nothing is sent until Colson sends it.</span></div>`}`
      : html`<div class="empty"><div class="t">Every timesheet checks out.</div></div>`}
    ${undo && html`<div class="ts-undo" style="padding:10px 14px;border-top:1px solid var(--line-2);display:flex;gap:10px;align-items:center">
      <span class="sm">Ignored ${who(undo)}.</span><button class="btn sec small" onClick=${() => ignore(undo, false)}>Undo</button></div>`}</div>
  </div>`;
}

const REMINDER = {
  requested: { cls: "info", label: "Reminder requested" },
  drafted: { cls: "held", label: "Draft in Gmail" },
  sent: { cls: "ok", label: "Reminder sent" },
  resolved: { cls: "ok", label: "Resolved" },
  cancelled: { cls: "grey", label: "Cancelled" },
};

function WageSyncButton({ user, onDone, compact }) {
  const [busy, setBusy] = useState(false);
  if (!user?.is_editor) return null;
  const go = async () => {
    setBusy(true);
    try { const r = await runWageSync(); await onDone(r.message || "Wage sync finished."); }
    catch (e) { await onDone("Wage sync failed: " + (e.message || e)); }
    finally { setBusy(false); }
  };
  return html`<button class=${compact ? "btn sync-btn" : "btn"} disabled=${busy} onClick=${go}
    title="Write the hours and wages below to each staffing record in Salesforce">
    <${Icon.sync}/> ${busy ? "Syncing…" : "Sync wages"}</button>`;
}

// Missing timesheets: tick the ones to chase, then ask for reminder emails.
function Missing({ rows, user, onChanged, onOpenEvent }) {
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const key = (r) => r.contact_sf_id + "|" + r.event_date;
  const open = rows.filter((r) => !r.reminder_status || r.reminder_status === "cancelled");
  const picked = rows.filter((r) => sel[key(r)]);
  const ask = async () => {
    setBusy(true); setErr("");
    try { await requestReminders(user, picked); setSel({}); await onChanged(`${picked.length} reminder${picked.length === 1 ? "" : "s"} requested. Claude will draft them in Colson's Gmail for review.`); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const through = rows[0]?.gusto_through;
  return html`<div>
    <div class="sec-h"><h3>Missing timesheets</h3><span class="mute">Staffed in Salesforce, but no Gusto shift that day${through ? ` (Gusto loaded through ${fmtDate(through)})` : ""}. Review, tick, then request reminders.</span></div>
    ${err && html`<div class="note red" style="margin-bottom:10px">${err}</div>`}
    <div class="card flush">${rows.length ? html`<table>
      <thead><tr><th></th><th>Date</th><th>Person</th><th>Staffed as</th><th>Gusto nearby</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => {
        const done = r.reminder_status && r.reminder_status !== "cancelled";
        return html`<tr key=${key(r)}>
          <td>${canEdit(user) && !done ? html`<input type="checkbox" checked=${!!sel[key(r)]} onChange=${(e) => setSel({ ...sel, [key(r)]: e.target.checked })}/>` : ""}</td>
          <td class="date-c">${fmtDate(r.event_date)}</td>
          <td><div class="b">${r.full_name || "(unknown)"}</div><div class="xs mute">${r.email || "no email on the Contact"}</div></td>
          <td class="memo-c sm"><a onClick=${() => onOpenEvent(r.opportunity_sf_id)}>${r.what}</a>${r.remote_only ? html`<div class="xs mute">Remote role: may have entered it on the editing day</div>` : ""}</td>
          <td class="sm">${r.no_gusto_record ? html`<span class="badge warn" title="This person has no Gusto timesheets at all in the loaded period">not in Gusto</span>` : (r.gusto_nearby ? html`<span title="Shifts entered within 3 days: maybe the wrong date">${r.gusto_nearby}</span>` : html`<span class="mute">none</span>`)}</td>
          <td>${done ? html`<span class="badge ${REMINDER[r.reminder_status]?.cls || "grey"}">${REMINDER[r.reminder_status]?.label || r.reminder_status}</span>` : html`<span class="badge bad">Needs entry</span>`}</td>
        </tr>`;
      })}</tbody></table>
      ${canEdit(user) && open.length > 0 && html`<div style="padding:12px 14px;border-top:1px solid var(--line-2);display:flex;gap:12px;align-items:center">
        <button class="btn small" disabled=${!picked.length || busy} onClick=${ask}>${busy ? "Saving…" : `Request reminder email${picked.length === 1 ? "" : "s"}${picked.length ? ` (${picked.length})` : ""}`}</button>
        <span class="xs mute">Claude drafts each one in Colson's Gmail. Nothing is sent until Colson sends it.</span></div>`}`
      : html`<div class="empty"><div class="t">No missing timesheets.</div><div class="sm">Everyone staffed has a Gusto shift for that day.</div></div>`}</div>
  </div>`;
}

// Review bonuses and tip shares: one list, with Mark paid once payroll has gone out.
function Extras({ bonuses, tips, user, onChanged, onOpenEvent }) {
  const [busy, setBusy] = useState("");
  const unpaidB = bonuses.filter((b) => !b.paid);
  const mark = async (kind, rows, label) => {
    setBusy(kind);
    try { await markExtraPaid(user, kind, rows); await onChanged(label); }
    catch (e) { await onChanged("Could not save: " + (e.message || e)); }
    finally { setBusy(""); }
  };
  return html`<div>
    <div class="sec-h"><h3>Bonuses and tips for payroll</h3><span class="mute">$25 per person per event with a 5-star Google review (not Event Photo Editors or salaried staff). Tips split evenly across everyone on-site.</span></div>
    <div class="card flush">${unpaidB.length || tips.length ? html`<table>
      <thead><tr><th>Type</th><th>Person</th><th>Event</th><th class="money">Amount</th><th></th></tr></thead>
      <tbody>
        ${unpaidB.map((b) => html`<tr key=${"b" + b.opportunity_sf_id + b.contact_sf_id}>
          <td><span class="badge ok">Google review</span></td><td class="b">${b.full_name}</td>
          <td class="sm"><a onClick=${() => onOpenEvent(b.opportunity_sf_id)}>${b.opportunity_name}</a><div class="xs mute">${fmtDate(b.event_date)} · ${b.roles}</div></td>
          <td class="money b">${$(b.amount_cents)}</td>
          <td>${user?.is_editor ? html`<button class="btn sec small" disabled=${!!busy} onClick=${() => mark("review_bonus", [b], "Marked as paid.")}>Mark paid</button>` : ""}</td></tr>`)}
        ${tips.map((t) => html`<tr key=${"t" + t.opportunity_sf_id + t.contact_sf_id}>
          <td><span class="badge info">Tip</span></td><td class="b">${t.full_name || "(unknown)"}</td>
          <td class="sm"><a onClick=${() => onOpenEvent(t.opportunity_sf_id)}>${t.opportunity_name}</a><div class="xs mute">${fmtDate(t.event_date)} · ${$(t.tip_cents)} tip ÷ ${t.crew_on_site} on-site</div></td>
          <td class="money b">${$(t.share_cents)}</td>
          <td class="xs mute">Tick “Tip paid via Payroll?” on the Opportunity once paid</td></tr>`)}
      </tbody></table>
      ${user?.is_editor && unpaidB.length > 1 && html`<div style="padding:12px 14px;border-top:1px solid var(--line-2)"><button class="btn small" disabled=${!!busy} onClick=${() => mark("review_bonus", unpaidB, "All review bonuses marked as paid.")}>Mark all ${unpaidB.length} review bonuses paid</button></div>`}`
      : html`<div class="empty"><div class="t">Nothing owed.</div><div class="sm">No unpaid review bonuses or tips.</div></div>`}</div>
  </div>`;
}

function Wages({ d, user, onChanged, onOpenEvent }) {
  const records = d.wageRecords || [];
  const flags = d.wageFlags || [];
  const runs = d.wageRuns || [];
  const issues = d.timesheetIssues || [];
  const issuePeople = new Set(issues.filter((i) => i.audience === "employee").map((i) => i.staffing_sf_id)).size;
  const missing = d.missingTimesheets || [];
  const bonuses = d.reviewBonuses || [];
  const tips = d.tipShares || [];

  const nameOf = useMemo(() => Object.fromEntries(records.map((r) => [r.opportunity_sf_id, r.opportunity_name])), [records]);
  const ready = records.filter((r) => r.sync_selected);
  const unpriced = records.filter((r) => r.needs_role);
  const queued = ready.reduce((s, r) => s + Number(r.on_site_wage_cents || 0) + Number(r.commute_wage_cents || 0), 0);
  const missingOpen = missing.filter((r) => !r.reminder_status || r.reminder_status === "cancelled");
  const owed = bonuses.filter((b) => !b.paid).reduce((s, b) => s + Number(b.amount_cents), 0) + tips.reduce((s, t) => s + Number(t.share_cents), 0);
  const sfh = (c) => c == null ? null : Number(c) / 100;

  return html`<div>
    <div class="page-h"><div><h2>Wages</h2>
      <div class="lead">Gusto timesheets with California overtime, priced at the rate each person should be paid for that role (their Salesforce status, or their Hourly Rate; commute is $25/hr). Wages for a multi-day trip sit on the Day 1 record.</div></div>
      <${WageSyncButton} user=${user} onDone=${onChanged}/></div>

    <div class="sumbar">
      <div class="sum ${missingOpen.length ? "bad" : ""}"><div class="k">Missing timesheets</div><div class="v">${missingOpen.length}</div><div class="s">not yet chased</div></div>
      <div class="sum ${issuePeople ? "warn" : ""}"><div class="k">Timesheets to fix</div><div class="v">${issuePeople}</div><div class="s">fix in Gusto before payroll</div></div>
      <div class="sum ${owed ? "info" : ""}"><div class="k">Bonuses and tips owed</div><div class="v">${$(owed)}</div><div class="s">add to this payroll</div></div>
      <div class="sum"><div class="k">Ticked to sync</div><div class="v">${ready.length}</div><div class="s">records · ${$(queued)}</div></div>
    </div>

    <${Missing} rows=${missing} user=${user} onChanged=${onChanged} onOpenEvent=${onOpenEvent}/>

    <${Timesheets} issues=${issues} shifts=${d.wageShifts || []} user=${user} onChanged=${onChanged} onOpenEvent=${onOpenEvent}/>

    <${Extras} bonuses=${bonuses} tips=${tips} user=${user} onChanged=${onChanged} onOpenEvent=${onOpenEvent}/>

    ${unpriced.length > 0 && html`<div>
      <div class="sec-h"><h3>Can't price yet</h3><span class="mute">No status or Hourly Rate on the Salesforce Contact. Fill it in there and these price themselves.</span></div>
      <div class="card flush"><table><thead><tr><th>Event</th><th>Person</th></tr></thead><tbody>
        ${unpriced.map((r) => html`<tr key=${r.staffing_sf_id}><td><a onClick=${() => onOpenEvent(r.opportunity_sf_id)}>${r.opportunity_name}</a><div class="xs mute">${fmtDate(r.event_date)}</div></td><td>${r.person_name || "(open slot)"}</td></tr>`)}
      </tbody></table></div></div>`}

    ${flags.length > 0 && html`<div>
      <div class="sec-h"><h3>Flagged by the Salesforce sync</h3><span class="mute">Left alone rather than overwrite something a person put there.</span></div>
      <div class="card flush"><table>
        <thead><tr><th>Record</th><th>Field</th><th class="money">In Salesforce</th><th class="money">Expected</th><th>Why</th></tr></thead>
        <tbody>${flags.map((f) => html`<tr key=${f.id}>
          <td><a onClick=${() => onOpenEvent(f.opportunity_sf_id)}>${nameOf[f.opportunity_sf_id] || "this event"}</a></td>
          <td class="sm">${WAGE_FIELD_LABEL[f.wage_field] || f.wage_field}</td>
          <td class="money">${f.wage_field.endsWith("hours") ? hrs(sfh(f.sf_value_cents)) : $(f.sf_value_cents)}</td>
          <td class="money">${f.wage_field.endsWith("hours") ? hrs(sfh(f.expected_cents)) : $(f.expected_cents)}</td>
          <td class="sm">${FLAG_TEXT[f.kind] || f.kind}</td></tr>`)}</tbody>
      </table></div></div>`}

    <${Records} records=${records} issues=${issues} user=${user} onChanged=${onChanged} onOpenEvent=${onOpenEvent}/>

    <div class="sec-h"><h3>Recent wage syncs</h3></div>
    <div class="card flush">${runs.length ? html`<table>
      <thead><tr><th>When</th><th>Started by</th><th>Result</th><th class="money">Fields</th><th>Detail</th></tr></thead>
      <tbody>${runs.map((r) => html`<tr key=${r.id}>
        <td style="white-space:nowrap">${fmtWhen(r.started_at)}</td>
        <td class="sm">${r.trigger === "daily" ? "Daily schedule" : r.triggered_by}</td>
        <td><span class="badge ${RUN_STATUS[r.status]?.cls || "grey"}">${RUN_STATUS[r.status]?.label || r.status}</span></td>
        <td class="money">${r.fields_written || 0}</td><td class="sm mute">${r.message}</td></tr>`)}</tbody>
    </table>` : html`<div class="empty"><div class="t">No wage syncs yet.</div></div>`}</div>
    <div style="height:10px"></div>
    <${Help}>Hours and wages go to Salesforce in two passes, hours first, because Salesforce recalculates the wage from the hours whenever the hours change. Editing the hours on a Day 1 record in Salesforce by hand resets that trip's wage total to one day's worth.</${Help}>
  </div>`;
}

export { Wages, WageSyncButton };
