import { html, CAT_LABEL, $, fmtDate, Icon, Help } from "./common.js";

function Reconcile({ d, onOpen }) {
  const rows = d.recon.filter((r) => r.state !== "ties").map((r) => ({ ...r, c: d.crew.find((x) => x.staffing_sf_id === r.staffing_sf_id) }))
    .filter((r) => r.c)
    .sort((a, b) => (b.c.event_date || "").localeCompare(a.c.event_date || "") || Math.abs(b.diff_cents) - Math.abs(a.diff_cents));
  const ties = d.recon.filter((r) => r.state === "ties").length;
  return html`<div>
    <div class="page-h"><div><h2>Reconcile with Salesforce</h2>
      <div class="lead">Person by person and category by category, what this app has placed against what the staffing record in Salesforce holds. <b>${ties}</b> pairs match; <b>${rows.length}</b> do not. Click a row to open the event.</div></div></div>
    <${Help}>Before 7 Sep the app never wrote to Salesforce, so those rows compare an estimate with hand-typed totals and are expected to differ. From 7 Sep on, a difference usually means Capital One or Gusto spend only Salesforce knows about, or a change still waiting for the next sync.</${Help}>
    <div style="height:14px"></div>
    <div class="card flush"><table><thead><tr><th>Event date</th><th>Event</th><th>Person</th><th>Category</th><th class="money">In Salesforce</th><th class="money">In this app</th><th class="money">Difference</th><th>Era</th><th></th></tr></thead><tbody>
    ${rows.map((r) => html`<tr class="click" key=${r.staffing_sf_id + r.sf_category} onClick=${() => onOpen(r.c.opportunity_sf_id)}>
      <td style="white-space:nowrap">${fmtDate(r.c.event_date)}</td><td class="sm">${d.events.find((e) => e.opportunity_sf_id === r.c.opportunity_sf_id)?.opportunity_name || ""}</td>
      <td>${r.c.full_name}</td><td>${CAT_LABEL[r.sf_category]}</td><td class="money">${$(r.salesforce_cents)}</td><td class="money">${$(r.tool_cents)}</td><td class="money b">${$(r.diff_cents)}</td>
      <td>${r.c.event_date >= "2026-09-07" ? html`<span class="badge info">Since the app</span>` : html`<span class="badge grey">Pre-tool</span>`}</td><td class="go"><${Icon.chev}/></td></tr>`)}
    </tbody></table>${rows.length === 0 && html`<div class="empty"><div class="t">Everything ties.</div></div>`}</div></div>`;
}

export { Reconcile };
