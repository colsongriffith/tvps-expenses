import { html } from "./common.js";

function Intro({ onHide }) {
  return html`<div class="card" style="position:relative">
    <div class="row" style="justify-content:space-between;margin-bottom:16px"><h3 style="font-size:16px">How this works</h3><a class="sm" onClick=${onHide}>Hide</a></div>
    <div class="steps">
      <div class="step"><div class="num">1</div><div><div class="t">Charges land here</div><div class="d">Press <b>Sync from Ramp</b> (it also runs each morning). Claude reads the memo, card holder, date and crew and pre-fills the event, staff and category, colored by how sure it is.</div></div></div>
      <div class="step"><div class="num">2</div><div><div class="t">Check and add</div><div class="d">Fix any dropdown, tick who it was for, and press <b>Add to event</b>. Japhy's card purchases need the staff they were for.</div></div></div>
      <div class="step"><div class="num">3</div><div><div class="t">Audit on Events</div><div class="d">Each event shows its added charges by crew member and category against what was billed. <b>Remove from event</b> sends a charge back here.</div></div></div>
      <div class="step"><div class="num">4</div><div><div class="t">Salesforce follows</div><div class="d">Added charges sync daily at 6am, or press <b>Sync all</b>. Hand edits in Salesforce are flagged, never overwritten.</div></div></div>
    </div>
  </div>`;
}

export { Intro };
