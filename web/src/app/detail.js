import {
  html, useState, useMemo, $, $0, CATS, CAT_LABEL, CAT_SHORT, CAT_HINT, SF_FIELD_LABEL, fmtDate, fmtShort, fmtWhen,
  place, Badge, Src, lineStatus, saveOverride, SYNC_FROM, tileState, canEdit,
} from "./common.js";

const REMOVE = "__remove__", OVERHEAD = "__overhead__";

// Person + category dropdowns on an added charge. Every change saves straight away.
function LineEditor({ line, crew, shares, user, onSave }) {
  const [busy, setBusy] = useState(false);
  if (!canEdit(user)) return null;
  const split = shares.length > 1;
  const run = async (payload, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    try { await onSave(payload); } finally { setBusy(false); }
  };
  const onPerson = (v) => {
    if (v === REMOVE) return run({ expense_line_id: line.expense_line_id, action: "remove", reason: "Removed from the event page" },
      `Remove ${line.merchant_name} ${$(line.line_cents)} from this event? It goes back to Not added on the Expenses tab${split ? " (all " + shares.length + " shares)" : ""}.`);
    if (v === OVERHEAD) return run({ expense_line_id: line.expense_line_id, action: "mark_overhead", reason: "Marked overhead from the event page" },
      `Mark ${line.merchant_name} ${$(line.line_cents)} as overhead? It comes off this event entirely.`);
    return run({ expense_line_id: line.expense_line_id, action: "reassign", staffing_sf_id: v, sf_category: line.sf_category },
      split ? `This charge is split ${shares.length} ways. Put the whole ${$(line.line_cents)} on one person?` : null);
  };
  const onCat = (c) => split
    ? run({ expense_line_id: line.expense_line_id, action: "split", split_staffing_ids: shares.map((s) => s.staffing_sf_id), sf_category: c })
    : run({ expense_line_id: line.expense_line_id, action: "reassign", staffing_sf_id: line.staffing_sf_id, sf_category: c });
  return html`<div class="ed ${busy ? "busy" : ""}">
    <select aria-label="Who this is for" value=${split ? "__split__" : line.staffing_sf_id} disabled=${busy} onChange=${(e) => onPerson(e.target.value)}>
      ${split && html`<option value="__split__">Split ${shares.length} ways</option>`}
      ${crew.map((c) => html`<option key=${c.staffing_sf_id} value=${c.staffing_sf_id}>${c.full_name || "(open slot)"}${c.role ? " · " + c.role : ""}</option>`)}
      <option disabled>──────────</option>
      <option value=${REMOVE}>Remove from event</option>
      <option value=${OVERHEAD}>Overhead (not an event cost)</option>
    </select>
    <select aria-label="Category" value=${line.sf_category || ""} disabled=${busy} onChange=${(e) => onCat(e.target.value)} title=${line.sf_category ? "Feeds " + SF_FIELD_LABEL[line.sf_category] : ""}>
      ${CATS.map((k) => html`<option key=${k} value=${k}>${CAT_LABEL[k]}</option>`)}
    </select>
    <button type="button" class="linkbtn xs" disabled=${busy} onClick=${() => onPerson(REMOVE)}>Remove from event</button>
    ${busy && html`<span class="xs mute">Saving…</span>`}
  </div>`;
}

function ChargeCell({ l, children, extra }) {
  return html`<td class="charge-c">
    <div><span class="merch">${l.merchant_name || "(no merchant)"}</span> <${Src} s=${l.source}/><span>${extra}</span></div>
    <div class="memo ${l.memo ? "" : "none"}">${l.memo || "no memo"}</div>
    ${children}
  </td>`;
}

const sumBy = (rows, k) => rows.filter((l) => l.sf_category === k).reduce((s, l) => s + l.allocated_cents, 0);
const ADDED = new Set(["written", "proposed", "historical"]);

function EventDetail({ d, oppId, onBack, backLabel, user, onChanged, onOpenExpenses }) {
  const [err, setErr] = useState("");
  const ev = d.events.find((e) => e.opportunity_sf_id === oppId);
  const lines = useMemo(() => d.lines.filter((l) => l.opportunity_sf_id === oppId), [d.lines, oppId]);
  const crew = useMemo(() => d.crew.filter((c) => c.opportunity_sf_id === oppId)
    .sort((a, b) => (a.full_name || "~").localeCompare(b.full_name || "~")), [d.crew, oppId]);
  const sharesOf = useMemo(() => {
    const m = {};
    for (const l of d.lines) (m[l.expense_line_id] ||= []).push(l);
    return m;
  }, [d.lines]);
  const queue = d.syncQueue.filter((q) => q.opportunity_sf_id === oppId);
  const queued = useMemo(() => new Set(d.syncQueue.map((r) => r.staffing_sf_id + "|" + r.sf_category)), [d.syncQueue]);
  const flags = d.syncFlags.filter((f) => f.opportunity_sf_id === oppId);

  if (!ev) return html`<div class="card">Event not found. <a onClick=${onBack}>Back</a></div>`;

  const save = async (payload) => {
    setErr("");
    try { await saveOverride(user, payload); await onChanged(payload.action === "remove" ? "Removed. It's back in Not added on the Expenses tab." : "Saved. Totals updated."); }
    catch (e) { setErr(e.message || String(e)); }
  };

  const placed = lines.filter((l) => l.staffing_sf_id && ADDED.has(l.status));
  const waiting = new Set(lines.filter((l) => l.status === "held" || l.status === "suggested").map((l) => l.expense_line_id));
  const waitingCents = lines.filter((l) => l.status === "held" || l.status === "suggested").reduce((s, l) => s + l.allocated_cents, 0);
  const byRec = {};
  for (const l of placed) (byRec[l.staffing_sf_id] ||= []).push(l);
  const sortL = (a) => a.slice().sort((x, y) => (x.charge_date || "").localeCompare(y.charge_date || "") || y.allocated_cents - x.allocated_cents);
  const pre = ev.event_date && ev.event_date < SYNC_FROM;

  const billed = Object.fromEntries(CATS.map((k) => [k, Number(ev.categories?.[k]?.billed || 0)]));
  const spent = Object.fromEntries(CATS.map((k) => [k, sumBy(placed, k)]));
  const tot = (o) => CATS.reduce((s, k) => s + o[k], 0);
  const billedT = tot(billed), spentT = tot(spent);
  const overCats = CATS.filter((k) => billed[k] > 0 && spent[k] > billed[k]);

  const catCells = (rows, cls = "") => CATS.map((k) => html`<td key=${k} class="money ${cls}">${$0(sumBy(rows, k))}</td>`);
  const amountCells = (l) => CATS.map((k) => html`<td key=${k} class="money amt-c ${k === l.sf_category ? "has" : ""}">${k === l.sf_category ? $(l.allocated_cents) : ""}</td>`);

  const personBlock = (c) => {
    const rows = sortL(byRec[c.staffing_sf_id] || []);
    const sfTot = (c.sf_total_cents || 0) + (c.sf_mileage_cents || 0);
    const tool = rows.reduce((s, l) => s + l.allocated_cents, 0);
    return html`<tbody key=${c.staffing_sf_id} class="pblock">
      <tr class="ph">
        <td colspan="2"><span class="nm">${c.full_name || "(open slot)"}</span> <span class="rl">${c.role || ""}</span>
          ${c.is_ops_buyer ? html`<span class="badge grey" style="margin-left:6px">ops buyer</span>` : ""}
          <div class="xs mute">In Salesforce ${$(sfTot)} <span class="faint">(read ${fmtWhen(c.fetched_at)})</span></div></td>
        ${catCells(rows, "b")}
        <td class="money b">${$0(tool) || "—"}</td><td></td>
      </tr>
      ${rows.length ? rows.map((l) => {
        const sh = sharesOf[l.expense_line_id] || [l];
        const paidBy = l.payer_contact_sf_id && l.payer_contact_sf_id !== c.contact_sf_id ? (l.payer_full_name || l.payer_name) : null;
        return html`<tr key=${l.allocation_id} class="ln">
          <td class="date-c">${fmtShort(l.charge_date)}</td>
          <${ChargeCell} l=${l} extra=${html`<span>${paidBy ? html`<span class="chip">paid by ${paidBy}</span>` : ""}${sh.length > 1 ? html`<span class="chip" title=${"Whole charge " + $(l.line_cents)}>1 of ${sh.length} · ${$(l.line_cents)} total</span>` : ""}</span>`}>
            <${LineEditor} line=${l} crew=${crew} shares=${sh} user=${user} onSave=${save}/>
          </${ChargeCell}>
          ${amountCells(l)}
          <td></td>
          <td class="st-c"><${Badge} s=${lineStatus(l, queued)}/></td>
        </tr>`;
      }) : html`<tr class="ln empty-row"><td></td><td class="mute sm" colspan=${CATS.length + 3}>No charges</td></tr>`}
    </tbody>`;
  };

  return html`<div>
    <div class="crumb"><a onClick=${onBack}>← ${backLabel}</a></div>
    <div class="page-h"><div>
      <h2>${ev.opportunity_name}</h2>
      <div class="lead">${fmtDate(ev.event_date)} · ${place(ev) || "no venue on record"} · ${ev.stage} · ${crew.length} on crew</div>
    </div><button class="btn sec" onClick=${() => onOpenExpenses(oppId)}>This event's charges on the Expenses tab</button></div>

    ${pre && html`<div class="note grey" style="margin-bottom:14px">This event is before 7 Sep, when the tool started. Its Salesforce totals were keyed by hand and the placements here are estimates. You can still move charges, but nothing on this event syncs to Salesforce.</div>`}

    <div class="sumbar">
      <div class="sum"><div class="k">Billed for travel</div><div class="v">${$(billedT)}</div>${Number(ev.billed_travel_fee_cents) ? html`<div class="s">+ ${$(ev.billed_travel_fee_cents)} travel fee</div>` : ""}</div>
      <div class="sum"><div class="k">Spent so far</div><div class="v">${$(spentT)}</div><div class="s">charges added to this event</div></div>
      <div class="sum ${billedT ? (spentT > billedT ? "bad" : "ok") : ""}"><div class="k">${spentT > billedT ? "Over budget" : "Left in budget"}</div><div class="v">${billedT ? $(Math.abs(billedT - spentT)) : "—"}</div><div class="s">${billedT ? (overCats.length ? "Over in " + overCats.map((k) => CAT_LABEL[k]).join(", ") : "every category within budget") : "nothing billed for travel"}</div></div>
      <div class="sum ${waiting.size ? "held" : ""} ${waiting.size ? "clickable" : ""}" onClick=${() => waiting.size && onOpenExpenses(oppId)}><div class="k">Waiting to be added</div><div class="v">${$(waitingCents)}</div><div class="s">${waiting.size ? html`<span>${waiting.size} charge${waiting.size === 1 ? "" : "s"} · <a>review on Expenses →</a></span>` : "nothing waiting"}</div></div>
    </div>

    ${(queue.length > 0 || flags.length > 0) && html`<div class="note blue" style="margin:0 0 14px">
      ${queue.length > 0 && html`<div><b>${queue.length} Salesforce field${queue.length === 1 ? "" : "s"}</b> on this event will change on the next sync: ${queue.map((q) => `${q.full_name || "?"} ${CAT_LABEL[q.sf_category]} ${q.delta_cents > 0 ? "+" : ""}${$(q.delta_cents)}`).join(" · ")}</div>`}
      ${flags.length > 0 && html`<div style="margin-top:4px"><b>${flags.length} field${flags.length === 1 ? " was" : "s were"} changed in Salesforce by hand</b>, so the sync is leaving ${flags.length === 1 ? "it" : "them"} alone. See the Salesforce sync tab.</div>`}
    </div>`}

    ${err && html`<div class="note red" style="margin-bottom:12px">Could not save: ${err}</div>`}

    <div class="card flush gridwrap"><table class="xgrid">
      <thead><tr><th>Date</th><th>Charge</th>${CATS.map((k) => html`<th key=${k} class="money" title=${CAT_HINT[k] + " → " + SF_FIELD_LABEL[k]}>${CAT_SHORT[k]}</th>`)}<th class="money">Total</th><th>Status</th></tr></thead>
      ${crew.map(personBlock)}
      <tfoot>
        <tr class="tot"><td colspan="2">Spent</td>${CATS.map((k) => html`<td key=${k} class="money">${$(spent[k])}</td>`)}<td class="money">${$(spentT)}</td><td></td></tr>
        <tr class="tot"><td colspan="2">Billed</td>${CATS.map((k) => html`<td key=${k} class="money">${$(billed[k])}</td>`)}<td class="money">${$(billedT)}</td><td></td></tr>
        <tr class="tot diff"><td colspan="2">Billed − spent</td>${CATS.map((k) => {
          const st = tileState({ billed: billed[k], spent: spent[k] });
          return html`<td key=${k} class="money ${st.cls}" title=${st.text}>${billed[k] || spent[k] ? $(billed[k] - spent[k]) : ""}</td>`;
        })}<td class="money ${billedT && spentT > billedT ? "bad" : "ok"}">${$(billedT - spentT)}</td><td></td></tr>
      </tfoot>
    </table></div>
    <div class="legend" style="margin-top:8px"><span>Only charges added on the Expenses tab count here. Change the person or category with the dropdowns under a charge, or remove it to send it back.</span><span>Positive "Billed − spent" means budget left; negative means over.</span></div>
  </div>`;
}

export { EventDetail };
