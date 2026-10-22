import {
  html, useState, useMemo, useEffect, useRef, $, CATS, CAT_LABEL, fmtDate, fmtShort, place, Icon, Src, Badge,
  guessCat, lineStatus, saveOverride, runRampSync, canEdit, fmtWhen,
} from "./common.js";

const OVERHEAD = "__overhead__";
const PAGE = 50;
const BUCKETS = [
  { k: "todo", label: "Not added to an event" },
  { k: "added", label: "Added to event" },
  { k: "overhead", label: "Overhead" },
  { k: "all", label: "All" },
];

// One row per charge, built from its placements.
function buildCharges(lines) {
  const m = new Map();
  for (const l of lines) {
    let c = m.get(l.expense_line_id);
    if (!c) {
      c = { id: l.expense_line_id, date: l.charge_date, payer: l.payer_full_name || l.payer_name || "—", payerContact: l.payer_contact_sf_id,
        japhy: /^japhy\b/i.test(l.payer_full_name || l.payer_name || ""), merchant: l.merchant_name, memo: l.memo, source: l.source, amount: l.line_cents,
        fine: l.fine_category, pending: l.clear_state === "pending", voided: l.clear_state === "void", allocs: [] };
      m.set(l.expense_line_id, c);
    }
    c.allocs.push(l);
  }
  for (const c of m.values()) {
    const st = new Set(c.allocs.map((a) => a.status));
    c.bucket = st.has("overhead") ? "overhead" : (st.has("held") || st.has("suggested")) ? (c.voided ? "overhead" : "todo") : "added";
    c.suggested = st.has("suggested");
    const a0 = c.allocs[0];
    c.conf = confOf(c, a0);
    c.saved = {
      event: c.bucket === "overhead" ? OVERHEAD : (a0.opportunity_sf_id || ""),
      staff: c.allocs.filter((a) => a.staffing_sf_id).map((a) => a.staffing_sf_id).sort(),
      cat: a0.sf_category || guessCat({ fine_category: c.fine }),
    };
  }
  return [...m.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.amount - a.amount);
}

// How sure the pre-filled guess is. Shown on rows the app filled in, never on a person's decision.
const CONF = {
  high: { label: "Strong match", short: "Strong", help: "The memo gives it away and the rules agree. Usually safe to add as is." },
  medium: { label: "Likely, check it", short: "Likely", help: "Probably right, but one part is a guess (often the staff member or the category)." },
  low: { label: "Verify", short: "Verify", help: "A weak guess or no guess at all. Check before adding." },
};
function confOf(c, a0) {
  const auto = c.bucket === "todo" || (c.bucket === "overhead" && !a0.override_id && a0.confidence);
  if (!auto) return null;
  const level = a0.confidence || (c.suggested ? "medium" : "low");
  const reason = a0.confidence_reason || (c.suggested ? "Guess carried over from an earlier placement." : (a0.note || "No guess yet. Choose the event and staff."));
  return { level, reason };
}

const same = (a, b) => a.event === b.event && a.cat === b.cat && a.staff.join() === b.staff.join();

// Popovers are position:fixed under their trigger, so the table's scroll box can't clip them.
function usePopPos(ref, open) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom, up = below < 260 && r.top > below;
      setPos(up ? { left: r.left, bottom: window.innerHeight - r.top + 4, minWidth: r.width }
                : { left: r.left, top: r.bottom + 4, minWidth: r.width });
    };
    place();
    addEventListener("scroll", place, true); addEventListener("resize", place);
    return () => { removeEventListener("scroll", place, true); removeEventListener("resize", place); };
  }, [open]);
  return pos;
}

// Checkbox list of the chosen event's crew, in a small popover.
function StaffPicker({ crew, value, onChange, disabled, payerContact }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const names = value.map((id) => crew.find((c) => c.staffing_sf_id === id)?.full_name || "?");
  const label = disabled ? "Pick an event first" : !value.length ? "Tick staff…" : names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(", ");
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id].sort());
  const pos = usePopPos(ref, open);
  return html`<div class="sp-wrap" ref=${ref}>
    <button type="button" class="sp-btn ${!value.length && !disabled ? "need" : ""}" disabled=${disabled} onClick=${() => setOpen(!open)} aria-label="Staff">${label}<span class="caret">▾</span></button>
    ${open && html`<div class="sp-pop" role="listbox" style=${pos || {}}>
      ${crew.length ? crew.map((c) => html`<label key=${c.staffing_sf_id} class="sp-opt">
        <input type="checkbox" checked=${value.includes(c.staffing_sf_id)} onChange=${() => toggle(c.staffing_sf_id)}/>
        <span><b>${c.full_name || "(open slot)"}</b> <span class="mute xs">${c.role || ""}</span>${c.contact_sf_id && c.contact_sf_id === payerContact ? html`<span class="badge info sm-b">paid</span>` : ""}</span></label>`)
        : html`<div class="mute sm" style="padding:8px 10px">No one is staffed on this event in Salesforce yet.</div>`}
      ${value.length > 1 && html`<div class="xs mute" style="padding:6px 10px;border-top:1px solid var(--line-2)">Split evenly ${value.length} ways.</div>`}
      <div style="padding:6px 8px;text-align:right"><button type="button" class="btn small" onClick=${() => setOpen(false)}>Done</button></div>
    </div>`}
  </div>`;
}

const DAY = 864e5;
const ms = (d) => new Date((d || "2026-01-01") + "T00:00:00").getTime();

// Which events a charge's dropdown offers (Colson, 21 Oct):
//   Japhy's card  -> events in the future or within the last 30 days (from today)
//   any other card -> only events the card holder is staffed on, within 30 days of the charge date
//   "Show more events" relaxes to every event. Closed Lost never appears.
function eventChoices(c, events, staffedBy, more, today) {
  const live = events.filter((e) => e.stage !== "Closed Lost");
  if (more) return live;
  if (c.japhy) return live.filter((e) => ms(e.event_date) >= today - 30 * DAY);
  const mine = staffedBy[c.payerContact];
  if (!mine) return [];
  const t = ms(c.date);
  return live.filter((e) => mine.has(e.opportunity_sf_id) && Math.abs(ms(e.event_date) - t) <= 30 * DAY);
}

// Type-to-search event picker. Click (or tab in) and start typing; the list narrows as you type.
function EventCombo({ events, all, value, date, more, onChange, onMore }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useRef(null), inp = useRef(null), listRef = useRef(null);
  const pos = usePopPos(ref, open);
  useEffect(() => {
    if (!open) return;
    // composedPath() is captured at dispatch time, so it still holds the clicked item even if
    // React has already removed it from the page (e.g. "Show more events" re-rendering the list).
    const close = (e) => { if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const { near, rest } = useMemo(() => {
    const t = ms(date);
    let list = events;
    if (value && value !== OVERHEAD && !list.some((e) => e.opportunity_sf_id === value)) {
      const cur = all.find((e) => e.opportunity_sf_id === value);
      if (cur) list = [cur, ...list];
    }
    const near = [], rest = [];
    for (const e of list) (Math.abs(ms(e.event_date) - t) <= 21 * DAY ? near : rest).push(e);
    near.sort((a, b) => Math.abs(ms(a.event_date) - t) - Math.abs(ms(b.event_date) - t));
    rest.sort((a, b) => ms(b.event_date) - ms(a.event_date));
    return { near, rest };
  }, [events, all, value, date]);
  const label = (e) => `${fmtShort(e.event_date)} · ${e.opportunity_name}`;
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (txt) => toks.every((t) => txt.toLowerCase().includes(t));
  const match = (e) => !toks.length || hit(`${e.opportunity_name} ${place(e)} ${fmtShort(e.event_date)} ${fmtDate(e.event_date)}`);
  const groups = more
    ? [{ g: near.length ? "Within 3 weeks of the charge" : null, list: near.filter(match) }, { g: "All events", list: rest.filter(match) }]
    : [{ g: null, list: [...near, ...rest].filter(match) }];
  const ohLabel = "Overhead (not an event cost)";
  const items = [...(hit(ohLabel) || !toks.length ? [{ id: OVERHEAD, text: ohLabel }] : []),
    ...groups.flatMap((g) => g.list.map((e) => ({ id: e.opportunity_sf_id, text: label(e), g: g.g })))];
  const total = near.length + rest.length;
  useEffect(() => setHi(0), [q, open]);
  useEffect(() => { listRef.current?.querySelector(".ev-opt.hi")?.scrollIntoView({ block: "nearest" }); }, [hi]);
  const pick = (id) => { onChange(id); setOpen(false); setQ(""); inp.current?.blur(); };
  const cur = value === OVERHEAD ? ohLabel : (all.find((e) => e.opportunity_sf_id === value) ? label(all.find((e) => e.opportunity_sf_id === value)) : "");
  const key = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (open && items[hi]) pick(items[hi].id); }
    else if (e.key === "Escape") { setOpen(false); setQ(""); inp.current?.blur(); }
  };
  let lastG;
  return html`<div class="ev-combo" ref=${ref}>
    <input ref=${inp} class="ev-in ${open ? "open" : ""}" aria-label="Event" role="combobox" aria-expanded=${open}
      value=${open ? q : cur} title=${cur} placeholder=${open ? "Type to search events…" : (total ? "Choose event…" : "No matching events")}
      onFocus=${() => { setOpen(true); setQ(""); }} onInput=${(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown=${key}/>
    <span class="caret">▾</span>
    ${open && html`<div class="ev-pop" role="listbox" ref=${listRef} style=${pos || {}}>
      ${items.map((it, i) => {
        const head = it.g && it.g !== lastG ? html`<div class="ev-g" key=${"g" + it.g}>${it.g}</div>` : null;
        lastG = it.g;
        return html`<div key=${it.id}>${head}<div class="ev-opt ${i === hi ? "hi" : ""} ${it.id === value ? "sel" : ""}" role="option"
          onMouseDown=${(e) => { e.preventDefault(); pick(it.id); }} onMouseEnter=${() => setHi(i)}>${it.text}</div></div>`;
      })}
      ${!items.length && html`<div class="ev-none">No events match “${q}”.</div>`}
      ${!more && html`<div class="ev-more" onMouseDown=${(e) => { e.preventDefault(); onMore(); }}>${toks.length ? "Search every event →" : "Show more events →"}</div>`}
    </div>`}
  </div>`;
}

function ChargeRow({ c, d, crewBy, staffedBy, today, queued, user, onSaved, onOpenEvent }) {
  const [draft, setDraft] = useState(c.saved);
  const [more, setMore] = useState(false);
  const choices = useMemo(() => eventChoices(c, d.events, staffedBy, more, today), [c, d.events, staffedBy, more, today]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Data refreshes after every save on the page. Only reset this row's picks when ITS saved placement changed,
  // so half-finished choices on other rows survive.
  const lastSaved = useRef(c.saved);
  useEffect(() => {
    if (same(lastSaved.current, c.saved)) return;
    lastSaved.current = c.saved; setDraft(c.saved); setErr("");
  }, [c.saved]);
  const crew = draft.event && draft.event !== OVERHEAD ? (crewBy[draft.event] || []) : [];
  const dirty = !same(draft, c.saved);
  const isOverhead = draft.event === OVERHEAD;
  const pickEvent = (ev) => {
    const cr = crewBy[ev] || [];
    const payer = cr.find((x) => x.contact_sf_id && x.contact_sf_id === c.payerContact);
    setDraft({ ...draft, event: ev, staff: payer ? [payer.staffing_sf_id] : [] });
  };
  const run = async (payload, msg) => {
    setBusy(true); setErr("");
    try { await saveOverride(user, { expense_line_id: c.id, ...payload }); await onSaved(msg); }
    catch (e) { setErr(e.message || String(e)); setBusy(false); }
  };
  const add = () => isOverhead
    ? run({ action: "mark_overhead", reason: "From the Expenses tab" }, "Marked as overhead.")
    : run(draft.staff.length === 1
        ? { action: "reassign", staffing_sf_id: draft.staff[0], sf_category: draft.cat }
        : { action: "split", split_staffing_ids: draft.staff, sf_category: draft.cat },
      c.bucket === "added" ? "Saved. Event totals updated." : "Added to the event.");
  const remove = () => run({ action: "remove", reason: "From the Expenses tab" }, "Removed from the event. It's back in Not added.");

  let action;
  if (!canEdit(user)) action = html`<span class="xs mute">View only</span>`;
  else if (isOverhead) action = c.bucket === "overhead" && !dirty ? html`<${Badge} s="overhead"/>`
    : html`<button class="btn small" disabled=${busy} onClick=${add}>${busy ? "Saving…" : "Mark overhead"}</button>`;
  else if (!draft.event) action = html`<button class="btn small" disabled>Choose an event</button>`;
  else if (!draft.staff.length) action = html`<button class="btn small" disabled title="Every expense needs a staff member before it can be written to Salesforce">Tick staff to add</button>`;
  else if (c.bucket === "added" && !dirty) {
    const a = c.allocs[0];
    action = html`<div class="row" style="gap:6px;flex-wrap:nowrap"><${Badge} s=${lineStatus(a, queued)}/><a class="xs" onClick=${remove} title="Send it back to Not added">Remove</a></div>`;
  } else action = html`<button class="btn small" disabled=${busy} onClick=${add}>${busy ? "Saving…" : c.bucket === "added" ? "Save change" : "Add to event"}</button>`;

  const evName = d.events.find((e) => e.opportunity_sf_id === c.saved.event)?.opportunity_name;
  const conf = c.conf && !dirty ? c.conf : null;
  return html`<tr class="xr ${c.bucket} ${conf ? "conf-" + conf.level : ""}">
    <td class="date-c">${fmtDate(c.date)}</td>
    <td class="card-c"><div class="b">${c.payer}</div><div><${Src} s=${c.source}/>${c.japhy ? html`<span class="chip jc" title="Bought on Japhy's card. Choose the staff it was for.">Japhy's card</span>` : ""}${c.pending ? html`<span class="chip">pending</span>` : ""}${c.voided ? html`<span class="chip" title="Ramp voided this charge. It is not a cost.">voided</span>` : ""}</div></td>
    <td class="memo-c"><div class="merch">${c.merchant || "(no merchant)"}</div><div class="memo ${c.memo ? "" : "none"}">${c.memo || "no memo in Ramp"}</div>
      ${conf ? html`<div class="cf-box"><div class="cf-line"><span class="cf ${conf.level}" title=${CONF[conf.level].help + "\n\n" + conf.reason}><span class="dot"></span>${CONF[conf.level].label}</span>${c.bucket === "todo" && c.suggested ? html`<span class="xs guess">Best guess${evName ? " · " + evName : ""}</span>` : ""}</div>
        ${conf.level !== "high" ? html`<div class="xs cf-why">${conf.reason}</div>` : ""}</div>` : ""}
      ${c.bucket === "added" && c.saved.event ? html`<div class="xs"><a onClick=${() => onOpenEvent(c.saved.event)}>Open event →</a></div>` : ""}
      ${err && html`<div class="xs" style="color:var(--bad)">${err}</div>`}</td>
    <td class="money b">${$(c.amount)}</td>
    <td class="ev-c"><${EventCombo} events=${choices} all=${d.events} value=${draft.event} date=${c.date} more=${more} onChange=${pickEvent} onMore=${() => setMore(true)}/>
      <button type="button" class="morebtn" onClick=${() => setMore(!more)}>${more ? "Show fewer events" : "Show more events"}</button>
      ${!more && !choices.length && html`<div class="xs mute">${c.japhy ? "No events in the last 30 days or upcoming." : "Not staffed on any event within 30 days of this charge."}</div>`}</td>
    <td class="staff-c"><${StaffPicker} crew=${crew} value=${draft.staff} disabled=${!draft.event || isOverhead} payerContact=${c.payerContact} onChange=${(s) => setDraft({ ...draft, staff: s })}/></td>
    <td class="cat-c"><select aria-label="Category" value=${draft.cat} disabled=${isOverhead} onChange=${(e) => setDraft({ ...draft, cat: e.target.value })}>${CATS.map((k) => html`<option key=${k} value=${k}>${CAT_LABEL[k]}</option>`)}</select></td>
    <td class="act-c">${action}</td>
  </tr>`;
}

// "Sync from Ramp": pulls new charges and Claude's best guesses into Not added.
function RampSyncButton({ d, user, onDone }) {
  const [busy, setBusy] = useState(false);
  if (!canEdit(user)) return null;
  const last = (d.rampRuns || []).find((r) => r.status !== "running");
  const go = async () => {
    setBusy(true);
    try { const r = await runRampSync(); await onDone(r.message || "Ramp sync finished."); }
    catch (e) { await onDone("Ramp sync failed: " + (e.message || e)); }
    finally { setBusy(false); }
  };
  return html`<div class="ramp-sync">
    <button class="btn" disabled=${busy} onClick=${go} title="Pull the latest Ramp charges. Claude pre-fills a best guess for each new one; nothing counts until someone presses Add.">
      <${Icon.sync}/> ${busy ? "Pulling from Ramp…" : "Sync from Ramp"}</button>
    <div class="xs mute" title=${last?.message || ""}>${busy ? "Claude is sorting new charges. This can take a minute." : last ? "Last pulled " + fmtWhen(last.finished_at || last.started_at) + (last.triggered_by && last.triggered_by !== "schedule" ? " by " + last.triggered_by.split("@")[0] : "") : "Not pulled from here yet"}</div>
  </div>`;
}

function Expenses({ d, user, onChanged, onOpenEvent, focusEvent, clearFocus }) {
  const [bucket, setBucket] = useState("todo");
  const [q, setQ] = useState("");
  const [payer, setPayer] = useState("");
  const [src, setSrc] = useState("");
  const [cf, setCf] = useState("");
  const [page, setPage] = useState(0);
  const charges = useMemo(() => buildCharges(d.lines), [d.lines]);
  const crewBy = useMemo(() => {
    const m = {};
    for (const c of d.crew) (m[c.opportunity_sf_id] ||= []).push(c);
    for (const k in m) m[k].sort((a, b) => (a.full_name || "~").localeCompare(b.full_name || "~"));
    return m;
  }, [d.crew]);
  const queued = useMemo(() => new Set(d.syncQueue.map((r) => r.staffing_sf_id + "|" + r.sf_category)), [d.syncQueue]);
  const staffedBy = useMemo(() => {
    const m = {};
    for (const c of d.crew) if (c.contact_sf_id) (m[c.contact_sf_id] ||= new Set()).add(c.opportunity_sf_id);
    return m;
  }, [d.crew]);
  const today = useMemo(() => ms(new Date().toISOString().slice(0, 10)), []);
  const evName = useMemo(() => Object.fromEntries(d.events.map((e) => [e.opportunity_sf_id, e.opportunity_name])), [d.events]);
  useEffect(() => { if (focusEvent) setBucket("all"); }, [focusEvent]);
  useEffect(() => setPage(0), [bucket, q, payer, src, focusEvent, cf]);

  const counts = useMemo(() => {
    const n = { todo: 0, added: 0, overhead: 0, all: charges.length };
    for (const c of charges) n[c.bucket]++;
    return n;
  }, [charges]);
  const payers = useMemo(() => [...new Set(charges.map((c) => c.payer))].sort(), [charges]);
  const rows = useMemo(() => {
    let r = charges;
    if (bucket !== "all") r = r.filter((c) => c.bucket === bucket);
    if (focusEvent) r = r.filter((c) => c.allocs.some((a) => a.opportunity_sf_id === focusEvent));
    if (payer) r = r.filter((c) => c.payer === payer);
    if (src) r = r.filter((c) => c.source === src);
    if (cf) r = r.filter((c) => c.conf?.level === cf);
    if (q) {
      const s = q.toLowerCase();
      r = r.filter((c) => [c.merchant, c.memo, c.payer, evName[c.saved.event]].some((x) => (x || "").toLowerCase().includes(s)) || $(c.amount).includes(q));
    }
    return r;
  }, [charges, bucket, focusEvent, payer, src, q, evName, cf]);
  const confN = useMemo(() => {
    const n = { high: 0, medium: 0, low: 0 };
    for (const c of charges) if (c.conf && (bucket === "all" || c.bucket === bucket)) n[c.conf.level]++;
    return n;
  }, [charges, bucket]);
  const showLegend = confN.high + confN.medium + confN.low > 0;
  const total = rows.reduce((s, c) => s + c.amount, 0);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const pages = Math.ceil(rows.length / PAGE);

  return html`<div>
    <div class="page-h"><div><h2>Expenses</h2>
      <div class="lead">Every Ramp, Gusto and Capital One charge, newest first. Press <b>Sync from Ramp</b> to pull new charges; Claude pre-fills its best guess. Check the event, tick the staff it was for and press <b>Add to event</b>. Event totals and Salesforce only count charges that have been added.</div></div>
      <${RampSyncButton} d=${d} user=${user} onDone=${onChanged}/></div>
    ${focusEvent && html`<div class="note blue" style="margin-bottom:12px">Showing charges for <b>${evName[focusEvent] || "this event"}</b>. <a onClick=${clearFocus}>Show every charge</a></div>`}
    <div class="card"><div class="row">
      <div class="seg light">${BUCKETS.map((b) => html`<button key=${b.k} class=${bucket === b.k ? "on" : ""} onClick=${() => setBucket(b.k)}>${b.label}<span class="n">${counts[b.k]}</span></button>`)}</div>
    </div><div class="row" style="margin-top:10px">
      <div class="search"><${Icon.search}/><input type="text" placeholder="Search merchant, memo, card, event or amount" value=${q} onInput=${(e) => setQ(e.target.value)}/></div>
      <select value=${payer} onChange=${(e) => setPayer(e.target.value)} aria-label="Card"><option value="">Every card</option>${payers.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}</select>
      <select value=${src} onChange=${(e) => setSrc(e.target.value)} aria-label="Source"><option value="">Every source</option><option value="Ramp">Ramp</option><option value="Gusto">Gusto</option><option value="Capital One">Capital One</option><option value="Manual">Manual entry</option></select>
    </div></div>
    ${showLegend && html`<div class="cf-legend"><span class="xs mute">How sure the pre-filled guess is:</span>
      ${["high", "medium", "low"].map((k) => html`<button key=${k} type="button" class="cf-chip ${k} ${cf === k ? "on" : ""}" title=${CONF[k].help} onClick=${() => setCf(cf === k ? "" : k)}><span class="dot"></span>${CONF[k].label}<span class="n">${confN[k]}</span></button>`)}
      ${cf && html`<a class="xs" onClick=${() => setCf("")}>Show all</a>`}</div>`}
    <div class="xs mute" style="margin:0 2px 8px">${rows.length} charge${rows.length === 1 ? "" : "s"} · ${$(total)}</div>
    <div class="card flush gridwrap"><table class="xtab">
      <thead><tr><th>Date</th><th>Card</th><th>Merchant · memo</th><th class="money">Amount</th><th>Event</th><th>Staff</th><th>Category</th><th></th></tr></thead>
      <tbody>${shown.map((c) => html`<${ChargeRow} key=${c.id} c=${c} d=${d} crewBy=${crewBy} staffedBy=${staffedBy} today=${today} queued=${queued} user=${user} onSaved=${onChanged} onOpenEvent=${onOpenEvent}/>`)}</tbody>
    </table>
    ${!rows.length && html`<div class="empty"><div class="t">${bucket === "todo" && !q && !payer && !src && !focusEvent ? "Every charge has been added to an event or marked overhead." : "No charges match."}</div></div>`}
    </div>
    ${pages > 1 && html`<div class="row pager"><button class="btn sec small" disabled=${page === 0} onClick=${() => { setPage(page - 1); scrollTo(0, 0); }}>← Newer</button><span class="sm mute">Page ${page + 1} of ${pages}</span><button class="btn sec small" disabled=${page >= pages - 1} onClick=${() => { setPage(page + 1); scrollTo(0, 0); }}>Older →</button></div>`}
  </div>`;
}

export { Expenses, buildCharges };
