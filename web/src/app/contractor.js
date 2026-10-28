import {
  html, useState, useMemo, $, fmtDate, fmtShort, fmtWhen, hrs, setContractorLine, setContractorInvoiceStatus,
} from "./common.js";

// Contractor invoices (Christina's monthly editing invoice). Claude reads the PDF, checks the math and matches each
// line to her staffing record; multi-day programs roll up to the Day 1 record. An editor checks it here and
// approves; approved totals go to On-Site Wages on the Day 1 record with the wage sync.
const STATUS = {
  review: { cls: "warn", label: "Needs review" },
  approved: { cls: "ok", label: "Approved" },
  void: { cls: "grey", label: "Void" },
};

function LineEditor({ line, options, onSave, onCancel, busy }) {
  const [rec, setRec] = useState(line.staffing_sf_id || "");
  const [tgt, setTgt] = useState(line.target_staffing_sf_id || "");
  return html`<div class="ci-edit" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px">
    <label class="xs mute">Event <select value=${rec} onChange=${(e) => setRec(e.target.value)} style="max-width:260px">
      <option value="">(none)</option>${options.map((o) => html`<option key=${o.id} value=${o.id}>${o.label}</option>`)}</select></label>
    <label class="xs mute">Goes on <select value=${tgt} onChange=${(e) => setTgt(e.target.value)} style="max-width:260px">
      <option value="">(same record)</option>${options.map((o) => html`<option key=${o.id} value=${o.id}>${o.label}</option>`)}</select></label>
    <button class="btn small" disabled=${busy || !rec} onClick=${() => onSave(rec, tgt || rec)}>Save</button>
    <button class="btn sec small" disabled=${busy} onClick=${onCancel}>Cancel</button></div>`;
}

function Invoice({ inv, lines, crew, eventName, user, onChanged, onOpenEvent }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const edit = !!user?.is_editor && inv.status === "review";
  // Her staffing records near the invoice dates, for the "change" pickers.
  const options = useMemo(() => {
    const dates = lines.map((l) => l.work_date).filter(Boolean).sort();
    const lo = dates[0], hi = dates[dates.length - 1];
    const shift = (d, n) => { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    return crew.filter((c) => c.contact_sf_id === inv.contact_sf_id && (!lo || (c.event_date >= shift(lo, -10) && c.event_date <= shift(hi, 10))))
      .sort((a, b) => (a.event_date || "").localeCompare(b.event_date || ""))
      .map((c) => ({ id: c.staffing_sf_id, label: `${fmtShort(c.event_date)} · ${eventName(c.opportunity_sf_id)}` }));
  }, [crew, lines, inv.contact_sf_id]);
  // Group lines by the Day 1 record their money goes on.
  const groups = [];
  const byT = {};
  for (const l of [...lines].sort((a, b) => (a.work_date || "").localeCompare(b.work_date || "") || a.line_no - b.line_no)) {
    const k = l.target_staffing_sf_id || "none:" + l.line_id;
    if (!byT[k]) groups.push(byT[k] = { key: k, lines: [], total: 0, hours: 0, name: l.target_opportunity_name, date: l.target_event_date, opp: l.target_opportunity_sf_id });
    byT[k].lines.push(l); byT[k].total += Number(l.total_cents); byT[k].hours += Number(l.qty_hours);
  }
  const act = async (fn, msg) => {
    setBusy(true); setErr("");
    try { await fn(); setEditing(null); await onChanged(msg); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const st = STATUS[inv.status] || { cls: "grey", label: inv.status };
  const unmatched = lines.filter((l) => !l.target_staffing_sf_id).length;
  return html`<div class="card flush" style="margin-bottom:14px">
    <div style="padding:12px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line-2)">
      <div><div class="b">${inv.vendor_name} · Invoice #${inv.invoice_no}</div>
        <div class="xs mute">${fmtDate(inv.invoice_date)} · ${inv.lines} lines · ${hrs(inv.hours)} · ${inv.records} Salesforce record${inv.records === 1 ? "" : "s"}</div></div>
      <div class="money b" style="margin-left:auto">${$(inv.total_cents)}</div>
      <span class="badge ${inv.math_ok ? "ok" : "bad"}" title=${inv.math_ok ? "Every line is hours × rate, and the lines add up to the subtotal and total." : (inv.problems || []).join("\n")}>${inv.math_ok ? "Math checks out" : "Math problem"}</span>
      <span class="badge ${st.cls}">${st.label}</span>
    </div>
    ${!inv.math_ok && html`<div class="note red" style="margin:10px 14px">${(inv.problems || []).map((p, i) => html`<div key=${i}>${p}</div>`)}</div>`}
    ${err && html`<div class="note red" style="margin:10px 14px">${err}</div>`}
    <table>
      <thead><tr><th>#</th><th>Date</th><th>Invoice line</th><th class="money">Hours</th><th class="money">Amount</th><th>Her staffing record</th></tr></thead>
      ${groups.map((g) => html`<tbody key=${g.key}>
        <tr class="ci-group"><td colSpan="3" style="background:var(--grey-bg)">
          ${g.opp ? html`<span><span class="xs mute">Goes on </span><a class="b" onClick=${() => onOpenEvent(g.opp)}>${g.name}</a><span class="xs mute"> · ${fmtDate(g.date)}${new Set(g.lines.map((l) => l.staffing_sf_id)).size > 1 ? ` · Day 1 of ${new Set(g.lines.map((l) => l.staffing_sf_id)).size}` : ""}</span></span>`
            : html`<span class="b" style="color:var(--bad)">Not matched to a staffing record</span>`}</td>
          <td class="money" style="background:var(--grey-bg)">${hrs(g.hours)}</td><td class="money b" style="background:var(--grey-bg)">${$(g.total)}</td>
          <td class="xs mute" style="background:var(--grey-bg)">On-Site Wages</td></tr>
        ${g.lines.map((l) => html`<tr key=${l.line_id}>
          <td class="sm mute">${l.line_no}</td>
          <td class="sm" style="white-space:nowrap">${fmtShort(l.work_date)}</td>
          <td class="sm">${l.description}${!l.math_ok ? html` <span class="badge bad">math</span>` : ""}</td>
          <td class="money sm">${hrs(Number(l.qty_hours))}</td>
          <td class="money sm">${$(l.total_cents)}</td>
          <td class="sm">${l.opportunity_sf_id ? html`<div><a onClick=${() => onOpenEvent(l.opportunity_sf_id)}>${l.opportunity_name}</a><div class="xs mute">${fmtDate(l.event_date)}${l.role ? " · " + l.role : ""}</div></div>` : html`<span style="color:var(--bad)">No match</span>`}
            ${l.match_note ? html`<div class="xs" style="color:var(--warn)">${l.match_note}</div>` : ""}
            ${edit && editing !== l.line_id ? html`<div><a class="xs" onClick=${() => setEditing(l.line_id)}>Change</a></div>` : ""}
            ${edit && editing === l.line_id ? html`<${LineEditor} line=${l} options=${options} busy=${busy} onCancel=${() => setEditing(null)}
              onSave=${(rec, tgt) => act(() => setContractorLine(l.line_id, rec, tgt), `Line ${l.line_no} updated.`)}/>` : ""}</td>
        </tr>`)}</tbody>`)}
    </table>
    <div style="padding:12px 14px;border-top:1px solid var(--line-2);display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      ${user?.is_editor && inv.status === "review" ? html`<span style="display:contents"><button class="btn small" disabled=${busy || unmatched > 0 || !inv.math_ok}
          title=${unmatched ? "Match every line first" : !inv.math_ok ? "The invoice math doesn't add up" : "Send these totals to On-Site Wages with the next wage sync"}
          onClick=${() => act(() => setContractorInvoiceStatus(inv.invoice_id, "approved"), `Invoice #${inv.invoice_no} approved. Its totals go to On-Site Wages with the next wage sync.`)}>Approve</button>
        <span class="xs mute">Approving puts each total under Hours and wages to sync, ticked. Nothing goes to Salesforce until the wage sync runs.</span></span>`
      : inv.status === "approved" ? html`<span style="display:contents"><span class="xs mute">Approved by ${inv.approved_by} · ${fmtWhen(inv.approved_at)}</span>
        ${user?.is_editor && html`<button class="btn sec small" disabled=${busy} onClick=${() => act(() => setContractorInvoiceStatus(inv.invoice_id, "review"), `Invoice #${inv.invoice_no} back in review.`)}>Back to review</button>`}</span>` : ""}
    </div>
  </div>`;
}

function ContractorInvoices({ invoices, lines, crew, events, user, onChanged, onOpenEvent }) {
  const names = useMemo(() => Object.fromEntries((events || []).map((e) => [e.opportunity_sf_id, e.opportunity_name])), [events]);
  const eventName = (id) => names[id] || id;
  const shown = (invoices || []).filter((i) => i.status !== "void");
  if (!shown.length) return null;
  return html`<div>
    <div class="sec-h"><h3>Contractor invoices</h3><span class="mute">Each line is matched to her staffing record for that event. Multi-day programs roll up so the whole amount goes on the Day 1 record. Check the matches, then press Approve.</span></div>
    ${shown.map((inv) => html`<${Invoice} key=${inv.invoice_id} inv=${inv} lines=${(lines || []).filter((l) => l.invoice_id === inv.invoice_id)}
      crew=${crew || []} eventName=${eventName} user=${user} onChanged=${onChanged} onOpenEvent=${onOpenEvent}/>`)}
  </div>`;
}

export { ContractorInvoices };
