import { useState, useMemo, html, $, fmtDate, todayISO, place, Icon, isPast, eventStatusWords } from "./common.js";

function EventList({ d, onOpen, mode, cutoff }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("spend");
  const base = useMemo(() => d.events.filter((e) => mode === "past" ? isPast(e, cutoff) : !isPast(e, cutoff)), [d.events, mode, cutoff]);
  const over = (e) => Object.values(e.categories || {}).some((x) => x.billed > 0 && x.spent > x.billed);
  const rows = useMemo(() => {
    let r = base;
    if (only === "flagged") r = r.filter(over);
    if (only === "held") r = r.filter((e) => e.held_lines > 0);
    if (only === "proposed") r = r.filter((e) => e.proposed_lines > 0);
    if (only === "spend") r = r.filter((e) => e.spent_cents > 0 || e.held_cents > 0);
    if (q) { const s = q.toLowerCase(); r = r.filter((e) => (e.opportunity_name || "").toLowerCase().includes(s) || place(e).toLowerCase().includes(s)); }
    // newest first, so this week's events are at the top
    return r.slice().sort((a, b) => (b.event_date || "").localeCompare(a.event_date || ""));
  }, [base, q, only]);
  const n = useMemo(() => ({
    flag: base.filter(over).length, held: base.filter((e) => e.held_lines > 0).length,
    prop: base.filter((e) => e.proposed_lines > 0).length, spend: base.filter((e) => e.spent_cents > 0 || e.held_cents > 0).length,
  }), [base]);
  const today = todayISO();
  return html`<div>
    <div class="page-h"><div>
      <h2>${mode === "past" ? "Past events" : "Current events"}</h2>
      <div class="lead">${mode === "past" ? html`Events more than 30 days old (before ${fmtDate(cutoff)}).` : html`The last 30 days and everything upcoming. Open an event to see its charges by crew member against what was billed.`}</div>
    </div></div>
    <div class="card"><div class="row">
      <div class="search"><${Icon.search}/><input type="text" placeholder="Search by event name or city" value=${q} onInput=${(e) => setQ(e.target.value)}/></div>
      <div class="seg light">
        <button class=${only === "spend" ? "on" : ""} onClick=${() => setOnly("spend")}>With charges<span class="n">${n.spend}</span></button>
        <button class=${only === "flagged" ? "on" : ""} onClick=${() => setOnly("flagged")}>Over budget<span class="n">${n.flag}</span></button>
        <button class=${only === "held" ? "on" : ""} onClick=${() => setOnly("held")}>Waiting to be added<span class="n">${n.held}</span></button>
        <button class=${only === "proposed" ? "on" : ""} onClick=${() => setOnly("proposed")}>Waiting to sync<span class="n">${n.prop}</span></button>
        <button class=${only === "all" ? "on" : ""} onClick=${() => setOnly("all")}>All<span class="n">${base.length}</span></button>
      </div>
    </div></div>
    <div class="card flush"><table>
      <thead><tr><th>Event</th><th class="hide-m">Where</th><th class="money">Billed</th><th class="money">Spent</th><th class="money">Billed − spent</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((e) => {
        const diff = Number(e.billed_category_cents) - Number(e.spent_cents);
        return html`<tr class="click" key=${e.opportunity_sf_id} onClick=${() => onOpen(e.opportunity_sf_id)}>
        <td><div class="b">${e.opportunity_name}</div><div class="xs mute">${fmtDate(e.event_date)}${e.event_date && e.event_date > today ? " · upcoming" : ""} · ${e.stage} · ${e.staffing_records} on crew</div></td>
        <td class="hide-m mute sm">${place(e) || "—"}</td>
        <td class="money">${$(e.billed_category_cents)}</td>
        <td class="money b">${$(e.spent_cents)}${Number(e.held_cents) ? html`<div class="xs" style="color:var(--held);font-weight:500">+ ${$(e.held_cents)} waiting to be added</div>` : ""}</td>
        <td class="money ${Number(e.billed_category_cents) ? (diff < 0 ? "bad" : "ok") : "mute"}">${Number(e.billed_category_cents) ? $(diff) : "—"}</td>
        <td><div class="status-words">${eventStatusWords(e)}</div></td>
        <td class="go"><${Icon.chev}/></td></tr>`;
      })}</tbody></table>
      ${rows.length === 0 && html`<div class="empty"><div class="t">No events match.</div><div class="sm">Try clearing the search or choosing All.</div></div>`}
    </div></div>`;
}

export { EventList };
