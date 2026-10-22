import { html, useState, $, CAT_LABEL, SF_FIELD_LABEL, fmtDate, fmtWhen, sb, runSync, Help, Icon } from "./common.js";

const RUN_STATUS = {
  ok: { cls: "ok", label: "Synced" },
  partial: { cls: "warn", label: "Synced, with flags" },
  nothing_to_do: { cls: "grey", label: "Nothing to sync" },
  not_connected: { cls: "warn", label: "Salesforce not connected" },
  failed: { cls: "bad", label: "Failed" },
  running: { cls: "info", label: "Running" },
};
const FLAG_TEXT = {
  hand_edit: "Changed in Salesforce by hand since the last sync",
  would_go_negative: "Removing the charge would take the field below zero",
  write_error: "Salesforce would not accept the write",
};

function SyncButton({ user, onDone, compact }) {
  const [busy, setBusy] = useState(false);
  if (!user?.is_editor) return null;
  const go = async () => {
    setBusy(true);
    try { const r = await runSync(); await onDone(r.message || "Sync finished."); }
    catch (e) { await onDone("Sync failed: " + (e.message || e)); }
    finally { setBusy(false); }
  };
  return html`<button class=${compact ? "btn sync-btn" : "btn"} disabled=${busy} onClick=${go} title="Write every change waiting in this app to Salesforce now">
    <${Icon.sync}/> ${busy ? "Syncing…" : "Sync all"}</button>`;
}

function SyncPage({ d, user, onOpen, onDone }) {
  const [busyFlag, setBusyFlag] = useState("");
  const last = d.syncRuns[0];
  const q = d.syncQueue.slice().sort((a, b) => (b.event_date || "").localeCompare(a.event_date || ""));
  const net = q.reduce((s, r) => s + Number(r.delta_cents), 0);
  const accept = async (f) => {
    setBusyFlag(f.id);
    const { error } = await sb.rpc("sf_sync_flag_accept", { p_flag: f.id });
    setBusyFlag("");
    await onDone(error ? "Could not resolve: " + error.message : "Kept the Salesforce value. The next sync carries on from it.");
  };
  return html`<div>
    <div class="page-h"><div><h2>Salesforce sync</h2>
      <div class="lead">Added charges reach each crew member's staffing record once a day at 6am, or now with <b>Sync all</b>. Only what moved here is written, so anything Salesforce holds that this app can't see is left alone.</div></div>
      <${SyncButton} user=${user} onDone=${onDone}/></div>

    ${last?.status === "not_connected" && html`<div class="note" style="margin-bottom:14px"><b>Salesforce is not connected yet.</b> Changes are queued below and will be written on the first sync after the connection is set up.</div>`}

    <div class="sumbar">
      <div class="sum"><div class="k">Last sync</div><div class="v sm2">${last ? fmtWhen(last.finished_at || last.started_at) : "never"}</div><div class="s">${last ? (RUN_STATUS[last.status]?.label || last.status) : ""}</div></div>
      <div class="sum ${q.length ? "info" : ""}"><div class="k">Waiting to sync</div><div class="v">${q.length}</div><div class="s">field${q.length === 1 ? "" : "s"} · net ${net >= 0 ? "+" : ""}${$(net)}</div></div>
      <div class="sum ${d.syncFlags.length ? "bad" : ""}"><div class="k">Flagged</div><div class="v">${d.syncFlags.length}</div><div class="s">skipped until someone decides</div></div>
    </div>

    <div class="sec-h"><h3>Flagged fields</h3><span class="mute">The sync leaves these alone so it never overwrites a hand edit.</span></div>
    <div class="card flush">${d.syncFlags.length ? html`<table><thead><tr><th>Event</th><th>Person</th><th>Field</th><th class="money">In Salesforce</th><th class="money">Expected</th><th class="money">Change waiting</th><th>Why</th><th></th></tr></thead><tbody>
      ${d.syncFlags.map((f) => html`<tr key=${f.id}>
        <td><a onClick=${() => onOpen(f.opportunity_sf_id)}>${f.opportunity_name}</a><div class="xs mute">${fmtDate(f.event_date)}</div></td>
        <td>${f.full_name || "—"}</td><td class="sm">${SF_FIELD_LABEL[f.sf_category]}</td>
        <td class="money">${$(f.sf_value_cents)}</td><td class="money">${$(f.expected_cents)}</td>
        <td class="money">${f.delta_cents > 0 ? "+" : ""}${$(f.delta_cents)}</td>
        <td class="sm">${FLAG_TEXT[f.kind] || f.kind}</td>
        <td>${user?.is_editor && f.kind === "hand_edit" ? html`<button class="btn sec small" disabled=${busyFlag === f.id} onClick=${() => accept(f)} title="Treat the Salesforce value as correct; the waiting change is then added on top of it">Keep Salesforce value</button>` : ""}</td>
      </tr>`)}</tbody></table>` : html`<div class="empty"><div class="t">Nothing flagged.</div></div>`}</div>

    <div class="sec-h"><h3>Waiting to sync</h3><span class="mute">Exactly what the next sync will add to or take off each field.</span></div>
    <div class="card flush">${q.length ? html`<table><thead><tr><th>Event</th><th>Person</th><th>Field</th><th class="money">Change</th><th></th></tr></thead><tbody>
      ${q.map((r) => html`<tr key=${r.staffing_sf_id + r.sf_category} class="click" onClick=${() => onOpen(r.opportunity_sf_id)}>
        <td>${r.opportunity_name}<div class="xs mute">${fmtDate(r.event_date)}</div></td><td>${r.full_name || "(open slot)"}</td>
        <td class="sm">${SF_FIELD_LABEL[r.sf_category]}</td>
        <td class="money b ${r.delta_cents < 0 ? "neg" : ""}">${r.delta_cents > 0 ? "+" : ""}${$(r.delta_cents)}</td>
        <td>${r.has_open_flag ? html`<span class="badge bad">flagged</span>` : ""}</td></tr>`)}</tbody></table>`
      : html`<div class="empty"><div class="t">Salesforce is up to date.</div><div class="sm">Anything you move on an event page shows up here until the next sync.</div></div>`}</div>

    <div class="sec-h"><h3>Recent syncs</h3></div>
    <div class="card flush">${d.syncRuns.length ? html`<table><thead><tr><th>When</th><th>Started by</th><th>Result</th><th class="money">Fields</th><th class="money">Net change</th><th>Detail</th></tr></thead><tbody>
      ${d.syncRuns.map((r) => html`<tr key=${r.id}><td style="white-space:nowrap">${fmtWhen(r.started_at)}</td>
        <td class="sm">${r.trigger === "daily" ? "Daily schedule" : r.triggered_by}</td>
        <td><span class="badge ${RUN_STATUS[r.status]?.cls || "grey"}">${RUN_STATUS[r.status]?.label || r.status}</span></td>
        <td class="money">${r.fields_written || 0}</td><td class="money">${$(r.net_cents || 0)}</td><td class="sm mute">${r.message}</td></tr>`)}
    </tbody></table>` : html`<div class="empty"><div class="t">No syncs yet.</div></div>`}</div>
    <div style="height:10px"></div>
    <${Help}>Every value written is logged with what Salesforce held before, so any sync can be reversed. Charges that haven't cleared on the card wait until they clear. Events before 7 Sep never sync.</${Help}>
  </div>`;
}

export { SyncPage, SyncButton };
