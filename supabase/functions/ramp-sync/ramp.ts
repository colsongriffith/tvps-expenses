// Ramp Developer API: sign in with client credentials and page through card transactions.
// Docs: https://docs.ramp.com/developer-api/v1  (token: POST /developer/v1/token, list: GET /developer/v1/transactions)

export const RAMP_BASE = "https://api.ramp.com/developer/v1";
export const RAMP_SCOPES = "transactions:read users:read receipts:read";

export type RampTxn = {
  id: string;
  amountCents: number;          // positive = spend, negative = refund
  time: string | null;          // ISO timestamp the card was used
  utcDate: string | null;       // YYYY-MM-DD of `time` in UTC (the tool's convention since run 1)
  merchant: string | null;
  merchantCategory: string | null;
  memo: string | null;
  userId: string | null;        // Ramp user UUID of the card holder
  userName: string | null;
  state: string;                // CLEARED, PENDING, DECLINED, ...
  receiptCount: number;
  accountingCategory: string | null;
};

type Fetch = typeof fetch;

export async function rampToken(clientId: string, clientSecret: string, f: Fetch = fetch): Promise<string> {
  const r = await f(`${RAMP_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: RAMP_SCOPES }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) {
    throw new Error(`Ramp sign-in failed (${r.status}): ${b.error_description || b.error || "check RAMP_CLIENT_ID / RAMP_CLIENT_SECRET and the app's scopes"}`);
  }
  return b.access_token as string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Accepts the Developer API shape and, defensively, the shape Ramp's MCP/export uses.
// deno-lint-ignore no-explicit-any
export function normalize(t: any): RampTxn | null {
  const id = t.id ?? t.transaction_uuid;
  if (!id) return null;
  const dollars = num(t.amount) ?? num(t.original_amount) ?? num(t.original_transaction_amount?.amount);
  if (dollars === null) return null;
  const time = t.user_transaction_time ?? t.transaction_time ?? t.accounting_date ?? null;
  const ch = t.card_holder || {};
  const name = [ch.first_name, ch.last_name].filter(Boolean).join(" ") || t.spent_by_user || null;
  const memo = (t.memo ?? t.reason_or_justification ?? "").toString().trim() || null;
  const receipts = t.receipts ?? t.receipt_uuids ?? [];
  // deno-lint-ignore no-explicit-any
  const acct = (t.accounting_field_selections ?? t.accounting_categories ?? []).find((a: any) =>
    /category/i.test(a.category_info?.type ?? a.type ?? a.tracking_category_name ?? ""));
  return {
    id: String(id),
    amountCents: Math.round(dollars * 100),
    time,
    utcDate: time ? new Date(time).toISOString().slice(0, 10) : null,
    merchant: t.merchant_name ?? t.merchant_descriptor ?? null,
    merchantCategory: t.sk_category_name ?? t.merchant_category ?? t.merchant_category_code_description ?? null,
    memo,
    userId: ch.user_id ?? t.spent_by_user_uuid ?? null,
    userName: name,
    state: String(t.state ?? "CLEARED").toUpperCase(),
    receiptCount: Array.isArray(receipts) ? receipts.length : 0,
    accountingCategory: acct?.name ?? acct?.tracking_category_option_name ?? null,
  };
}

// All transactions from `fromDate` (YYYY-MM-DD) to now, following Ramp's page.next links.
export async function rampTransactions(token: string, fromDate: string, f: Fetch = fetch, maxPages = 50): Promise<RampTxn[]> {
  const out: RampTxn[] = [];
  let url: string | null = `${RAMP_BASE}/transactions?` + new URLSearchParams({
    from_date: `${fromDate}T00:00:00Z`,
    page_size: "100",
  });
  for (let i = 0; url && i < maxPages; i++) {
    const r: Response = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Ramp transactions request failed (${r.status}): ${JSON.stringify(b).slice(0, 300)}`);
    for (const t of b.data ?? []) {
      const n = normalize(t);
      if (n) out.push(n);
    }
    url = b.page?.next || null;
  }
  return out;
}
