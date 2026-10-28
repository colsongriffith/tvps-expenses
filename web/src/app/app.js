import { useState, useEffect, useMemo, useCallback, html, sb, daysAgoISO, loadAll, isPast, fmtWhen } from "./common.js";
import { createRoot } from "react-dom/client";
import { Login } from "./login.js";
import { EventList } from "./list.js";
import { EventDetail } from "./detail.js";
import { Reconcile } from "./recon.js";
import { Intro } from "./intro.js";
import { SyncPage, SyncButton } from "./sync.js";
import { Expenses, buildCharges } from "./expenses.js";
import { Wages } from "./wages.js";

const TABS = ["expenses", "current", "past", "wages", "sync", "recon"];

function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState(() => { const h = location.hash.slice(1); return TABS.includes(h) ? h : "expenses"; });
  const [opp, setOpp] = useState(null);
  const [from, setFrom] = useState("expenses");
  const [focusEvent, setFocusEvent] = useState(null);
  const [toast, setToast] = useState("");
  const [intro, setIntro] = useState(() => { try { return localStorage.getItem("tvps.intro.v4.hidden") !== "1"; } catch { return true; } });
  const cutoff = useMemo(() => daysAgoISO(30), []);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    try { setD(await loadAll()); setErr(""); } catch (e) { setErr(e.message || String(e)); }
  }, []);
  const say = useCallback((t) => { setToast(t); setTimeout(() => setToast(""), 4500); }, []);
  const changed = useCallback(async (msg) => { await refresh(); if (msg) say(msg); }, [refresh, say]);

  // Load once per signed-in user, not on every hourly token refresh.
  const userId = session?.user?.id || session?.user?.email;
  useEffect(() => {
    if (!userId) return;
    (async () => {
      const { data, error } = await sb.rpc("app_me");
      if (error) { setErr(error.message); return; }
      setMe(data?.[0] || null);
      await refresh();
    })();
  }, [userId, refresh]);

  useEffect(() => {
    const hh = () => {
      const m = location.hash.match(/^#ev=(.+)$/);
      if (m) setOpp(decodeURIComponent(m[1]));
      else { const h = location.hash.slice(1); if (TABS.includes(h)) { setOpp(null); setTab(h); } }
    };
    addEventListener("hashchange", hh);
    return () => removeEventListener("hashchange", hh);
  }, []);
  useEffect(() => { const m = location.hash.match(/^#ev=(.+)$/); if (m) setOpp(decodeURIComponent(m[1])); }, []);

  const openEv = (id) => {
    const e = d?.events.find((x) => x.opportunity_sf_id === id);
    setFrom(tab === "current" && e && isPast(e, cutoff) ? "past" : tab);
    setOpp(id); location.hash = "ev=" + encodeURIComponent(id); window.scrollTo(0, 0);
  };
  const go = (t) => { setTab(t); setOpp(null); setFocusEvent(null); history.replaceState(null, "", location.pathname + "#" + t); window.scrollTo(0, 0); };
  const back = () => go(from);
  const openExpenses = (id) => { go("expenses"); setFocusEvent(id); };
  const hideIntro = () => { setIntro(false); try { localStorage.setItem("tvps.intro.v4.hidden", "1"); } catch {} };
  const showIntro = () => { setIntro(true); try { localStorage.removeItem("tvps.intro.v4.hidden"); } catch {} };

  if (session === undefined) return html`<div class="center mute">Loading…</div>`;
  if (!session) return html`<${Login}/>`;
  if (me && !me.is_member) return html`<div class="center"><div class="card login"><h2>Not on the list</h2><div class="sm mute">${me.email} is not a TVPS address, so there is nothing to show. <a onClick=${() => sb.auth.signOut()}>Sign out</a> and try your work email.</div></div></div>`;

  const todoN = d ? buildCharges(d.lines).filter((c) => c.bucket === "todo").length : 0;
  const pastN = d ? d.events.filter((e) => isPast(e, cutoff)).length : 0;
  const syncN = d ? d.syncQueue.length + d.syncFlags.length : 0;
  const wageN = d ? d.missingTimesheets.filter((r) => !r.reminder_status || r.reminder_status === "cancelled").length + d.wageRateFlags.length : 0;
  const last = d?.syncRuns?.[0];
  const backLabel = { expenses: "Expenses", past: "Past events", wages: "Wages", sync: "Salesforce sync", recon: "Reconcile" }[from] || "Events";
  const on = (t) => tab === t && !opp ? "on" : "";

  return html`<div>
    <div class="top"><h1>TVPS Event Expenses</h1>
      <div class="seg">
        <button class=${on("expenses")} onClick=${() => go("expenses")} title="Every charge, newest first">Expenses${todoN ? html`<span class="n">${todoN}</span>` : ""}</button>
        <button class=${on("current")} onClick=${() => go("current")} title="Event totals: last 30 days and upcoming">Events</button>
        <button class=${on("past")} onClick=${() => go("past")} title="Events more than 30 days old">Past<span class="n">${pastN}</span></button>
        <button class=${on("wages")} onClick=${() => go("wages")} title="Gusto hours and wages by person and event">Wages${wageN ? html`<span class="n">${wageN}</span>` : ""}</button>
        <button class=${on("sync")} onClick=${() => go("sync")} title="What goes to Salesforce, and anything flagged">Salesforce sync${syncN ? html`<span class="n">${syncN}</span>` : ""}</button>
        <button class=${on("recon")} onClick=${() => go("recon")} title="Where this app and Salesforce disagree">Reconcile</button>
      </div>
      <span class="sp"></span>
      ${d && html`<span class="lastsync" title=${last?.message || ""}>Last sync ${fmtWhen(last?.finished_at || last?.started_at)}</span>`}
      ${d && html`<${SyncButton} user=${me} compact=${true} onDone=${changed}/>`}
      <span class="who">${me?.email}<span class="role">${me?.is_editor ? "Admin" : me?.is_member ? "Editor" : "Viewer"}</span><a onClick=${() => sb.auth.signOut()}>Sign out</a></span></div>
    <div class=${"wrap" + (tab === "expenses" && !opp ? " wide" : "")}>
      ${err && html`<div class="note red" style="margin-bottom:12px">Something went wrong loading data: ${err}</div>`}
      ${d ? html`<div>
        ${intro && !opp && tab === "expenses" && html`<${Intro} onHide=${hideIntro}/>`}
        ${opp ? html`<${EventDetail} d=${d} oppId=${opp} onBack=${back} backLabel=${backLabel} user=${me} onChanged=${changed} onOpenExpenses=${openExpenses}/>`
          : tab === "expenses" ? html`<${Expenses} d=${d} user=${me} onChanged=${changed} onOpenEvent=${openEv} focusEvent=${focusEvent} clearFocus=${() => setFocusEvent(null)}/>`
          : tab === "recon" ? html`<${Reconcile} d=${d} onOpen=${openEv}/>`
          : tab === "wages" ? html`<${Wages} d=${d} user=${me} onChanged=${changed} onOpenEvent=${openEv}/>`
          : tab === "sync" ? html`<${SyncPage} d=${d} user=${me} onOpen=${openEv} onDone=${changed}/>`
          : html`<${EventList} d=${d} onOpen=${openEv} mode=${tab} cutoff=${cutoff}/>`}
        <div class="foot">Ramp charges arrive each morning at 5:30 or on <b>Sync from Ramp</b>. Salesforce updates at 6am or on <b>Sync all</b>. ${!intro && html`<a onClick=${() => { showIntro(); go("expenses"); }}>How this works</a>`}</div>
      </div>` : html`<div class="mute">Loading data…</div>`}
    </div>
    ${toast && html`<div class="toast">${toast}</div>`}
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App}/>`);
