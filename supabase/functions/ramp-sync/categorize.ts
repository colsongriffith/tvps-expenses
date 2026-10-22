// Asks Claude (Messages API, forced tool use) for a best-guess placement for each new charge.
// Output is never counted anywhere until a person presses "Add to event" in the app.

export const SF_CATS = ["flights", "baggage", "hotels", "transportation", "per_diem", "other", "mileage"] as const;
export const FINE_CATS = ["flights", "baggage", "hotels", "rental_car", "parking", "tolls", "rideshare", "taxi", "fuel",
  "per_diem", "meals", "groceries", "wifi_inflight", "carts", "supplies", "mileage", "other"] as const;
export type SfCat = typeof SF_CATS[number];

export type Charge = {
  line_id: string; date: string; amount_cents: number; merchant: string | null; merchant_category: string | null;
  memo: string | null; card_holder: string | null; card_holder_contact: string | null; is_ops_buyer: boolean;
  receipt_count: number;
};
export type CrewMember = { staffing_sf_id: string; name: string | null; contact_sf_id: string | null; role: string | null };
export type Event = { opportunity_sf_id: string; name: string; date: string; city: string | null; state: string | null; crew: CrewMember[] };

export type Placement = {
  charge_id: string;
  decision: "event" | "overhead" | "unknown";
  opportunity_sf_id?: string | null;
  staffing_sf_ids?: string[];
  category?: SfCat | null;
  fine_category?: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export const SYSTEM = `You place company card charges for The Vanity Portrait Studio (TVPS), an event photography company, onto the event (Salesforce opportunity) and crew member (staffing record) they belong to, in an expense category.
A person reviews every guess before it counts, so be honest about how sure you are.

House rules (from the owner, Colson):
- The memo is the main signal. If it names an event, client, city or person, follow it. Never let date proximity beat an explicit event name in the memo.
- Only place a charge on a crew member who is listed on that event's crew. Use staffing_sf_ids from the crew list only.
- Normally the card holder is the person the cost is for, if they are on that event's crew.
- Ops buyers (is_ops_buyer = true, e.g. Japhy) book travel for others. Put their purchases on the crew member(s) the memo names; on themselves only if they are on that crew; if nobody is named and they are not on the crew, split evenly across the crew.
- A name in a memo is not always the beneficiary (e.g. "shipping to Chelsea" is an address).
- Multi-day trips: put every cost on the FIRST day's event record. If two different gigs share the same date and the memo names both, split evenly between them.
- Travel is often bought weeks ahead (flights, hotels): match it to a future event in the memo's city or for the named person.
- Airport rides, airport parking and travel-day meals belong to the trip, not to a local event that happens the same day.
- Company overhead (decision "overhead"): software subscriptions (Claude, Wispr, Adobe...), job postings, networking/registration, studio supplies, durable kit, and anything for the company van ("Whippy") such as van gas, maintenance or washes. Consumables bought for a named gig follow the gig instead.
- A charge and its refund (same merchant and amount, negative) both go to overhead when the memo says it was refunded.
- Categories: flights; baggage (bag fees); hotels (lodging, Airbnb); transportation (Uber/Lyft/taxi, rental car, fuel for rental cars, parking, tolls); per_diem (meals, coffee, groceries, snacks on a trip); other (airport carts, in-flight wifi, supplies for a gig); mileage (only for mileage reimbursements).
- Ignore Ramp's trip field and accounting category if they conflict with the memo.

Confidence:
- high: the memo gives it away and the rules agree (e.g. "Per diem for Harvey AI", card holder on that crew that day).
- medium: the event is probably right but one part is a guess (whose bag or room, how to split, event vs overhead, or no memo but the card holder was on a crew that day).
- low: a weak guess, or decision "unknown".

Reasons: one short plain sentence a busy person can scan (under 140 characters). Say what the guess rests on.`;

export const TOOL = {
  name: "record_placements",
  description: "Record one placement for every charge you were given.",
  input_schema: {
    type: "object",
    properties: {
      placements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            charge_id: { type: "string" },
            decision: { type: "string", enum: ["event", "overhead", "unknown"] },
            opportunity_sf_id: { type: ["string", "null"] },
            staffing_sf_ids: { type: "array", items: { type: "string" } },
            category: { type: ["string", "null"], enum: [...SF_CATS, null] },
            fine_category: { type: ["string", "null"], enum: [...FINE_CATS, null] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            reason: { type: "string" },
          },
          required: ["charge_id", "decision", "confidence", "reason"],
        },
      },
    },
    required: ["placements"],
  },
};

const DAY = 864e5;
const t = (d: string) => new Date(d + "T00:00:00Z").getTime();

// Events worth showing Claude for this batch: from 30 days before the earliest charge to 75 days after the latest.
export function eventsFor(charges: Charge[], events: Event[]): Event[] {
  const ds = charges.map((c) => t(c.date));
  const lo = Math.min(...ds) - 30 * DAY, hi = Math.max(...ds) + 75 * DAY;
  return events.filter((e) => t(e.date) >= lo && t(e.date) <= hi);
}

export function prompt(charges: Charge[], events: Event[]): string {
  const ev = events.map((e) => ({
    id: e.opportunity_sf_id, name: e.name, date: e.date, where: [e.city, e.state].filter(Boolean).join(", ") || null,
    crew: e.crew.map((c) => ({ staffing_sf_id: c.staffing_sf_id, name: c.name, role: c.role })),
  }));
  const ch = charges.map((c) => ({
    charge_id: c.line_id, date: c.date, amount: (c.amount_cents / 100).toFixed(2), merchant: c.merchant,
    merchant_category: c.merchant_category, memo: c.memo, card_holder: c.card_holder, is_ops_buyer: c.is_ops_buyer,
  }));
  return `Events (Booked / Closed Won / Photos Delivered) near these dates, with crews:\n${JSON.stringify(ev)}\n\n` +
    `Charges to place (${ch.length}):\n${JSON.stringify(ch)}\n\nCall record_placements with exactly one placement per charge_id.`;
}

type Fetch = typeof fetch;

export async function askClaude(apiKey: string, model: string, charges: Charge[], events: Event[], f: Fetch = fetch): Promise<Placement[]> {
  const r = await f("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: prompt(charges, events) }],
    }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude request failed (${r.status}): ${b.error?.message || JSON.stringify(b).slice(0, 300)}`);
  // deno-lint-ignore no-explicit-any
  const use = (b.content || []).find((c: any) => c.type === "tool_use" && c.name === TOOL.name);
  return (use?.input?.placements || []) as Placement[];
}

export type AllocRow = {
  expense_line_id: string; staffing_sf_id: string | null; opportunity_sf_id: string | null; contact_sf_id: string | null;
  sf_category: SfCat | null; amount_cents: number; status: "suggested" | "held" | "overhead"; basis: string; note: string | null;
  confidence: "high" | "medium" | "low"; confidence_reason: string;
};
export type LineUpdate = { id: string; intent: "event" | "overhead" | "ambiguous"; fine_category: string | null };

// Turn Claude's answer into rows the database will accept. Anything that doesn't check out becomes "held" (red).
export function toRows(charge: Charge, p: Placement | undefined, events: Event[], basis: string): { rows: AllocRow[]; line: LineUpdate } {
  const amt = charge.amount_cents;
  const reason = (p?.reason || "No guess. Choose the event and staff.").slice(0, 300);
  const fine = p?.fine_category && (FINE_CATS as readonly string[]).includes(p.fine_category) ? p.fine_category : null;
  const held = (why: string, conf: "medium" | "low" = "low"): { rows: AllocRow[]; line: LineUpdate } => ({
    rows: [{ expense_line_id: charge.line_id, staffing_sf_id: null, opportunity_sf_id: null, contact_sf_id: null, sf_category: null,
      amount_cents: amt, status: "held", basis, note: why, confidence: conf, confidence_reason: why }],
    line: { id: charge.line_id, intent: "ambiguous", fine_category: fine },
  });
  if (!p) return held("Claude gave no answer for this charge.");

  if (p.decision === "overhead") {
    if (p.confidence === "high") {
      return {
        rows: [{ expense_line_id: charge.line_id, staffing_sf_id: null, opportunity_sf_id: null, contact_sf_id: null, sf_category: null,
          amount_cents: amt, status: "overhead", basis, note: reason, confidence: "high", confidence_reason: reason }],
        line: { id: charge.line_id, intent: "overhead", fine_category: fine },
      };
    }
    return held("Probably overhead: " + reason, "medium");
  }
  if (p.decision !== "event") return held(reason);

  const ev = events.find((e) => e.opportunity_sf_id === p.opportunity_sf_id);
  if (!ev) return held("Suggested an event that isn't on the list: " + reason);
  const crew = (p.staffing_sf_ids || []).map((id) => ev.crew.find((c) => c.staffing_sf_id === id)).filter(Boolean) as CrewMember[];
  const uniq = [...new Map(crew.map((c) => [c.staffing_sf_id, c])).values()];
  const cat = p.category && (SF_CATS as readonly string[]).includes(p.category) ? p.category : null;
  if (!uniq.length || !cat) {
    // Event known but no valid person or category: keep the event as a hint on a held row.
    return {
      rows: [{ expense_line_id: charge.line_id, staffing_sf_id: null, opportunity_sf_id: ev.opportunity_sf_id, contact_sf_id: null,
        sf_category: cat, amount_cents: amt, status: "held", basis, note: reason, confidence: "low",
        confidence_reason: (!uniq.length ? "Event guessed, staff not: " : "Event guessed, category not: ") + reason }],
      line: { id: charge.line_id, intent: "event", fine_category: fine },
    };
  }
  const n = uniq.length, base = Math.trunc(amt / n), rem = amt - base * n;
  const conf = n > 1 && p.confidence === "high" ? "high" : p.confidence;
  return {
    rows: uniq.map((c, i) => ({
      expense_line_id: charge.line_id, staffing_sf_id: c.staffing_sf_id, opportunity_sf_id: ev.opportunity_sf_id,
      contact_sf_id: c.contact_sf_id, sf_category: cat, amount_cents: base + (i === 0 ? rem : 0), status: "suggested",
      basis: n > 1 ? basis + ":split" : basis, note: n > 1 ? `Split evenly ${n} ways.` : null, confidence: conf, confidence_reason: reason,
    })),
    line: { id: charge.line_id, intent: "event", fine_category: fine },
  };
}
