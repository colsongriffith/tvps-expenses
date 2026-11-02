-- Contractor invoices leave the Wages tab once their totals are in Salesforce (2 Nov 2026).
-- Applied to apzwwfuvoggiyfzgazdp on 2 Nov 2026; this file mirrors the live view definitions.

-- Each approved Day 1 total against the active On-Site Wages row the wage sync wrote.
create or replace view public.v_contractor_written with (security_invoker = on) as
select cw.staffing_sf_id,
       cw.on_site_wage_cents,
       l.amount_cents as written_cents,
       l.synced_at    as written_at,
       l.amount_cents is not null and l.amount_cents = cw.on_site_wage_cents as in_salesforce
from public.v_contractor_wage cw
left join public.wage_sync_ledger l
  on l.active and l.staffing_sf_id = cw.staffing_sf_id and l.wage_field = 'on_site_wages';
grant select on public.v_contractor_written to authenticated;

-- Lines gain in_salesforce + written_at (added at the end, so create or replace works).
create or replace view public.v_app_contractor_line with (security_invoker = on) as
select l.id as line_id, l.invoice_id, i.invoice_no, i.status as invoice_status, i.contact_sf_id, i.vendor_name,
       l.line_no, l.work_date, l.description, l.qty_hours, l.unit_cents, l.total_cents, l.math_ok,
       l.staffing_sf_id, s.opportunity_sf_id, s.opportunity_name, s.event_date, s.role,
       l.target_staffing_sf_id,
       t.opportunity_sf_id as target_opportunity_sf_id,
       t.opportunity_name  as target_opportunity_name,
       t.event_date        as target_event_date,
       l.match_score, l.match_note, l.set_by, l.set_at,
       coalesce(w.in_salesforce, false) and i.status = 'approved' as in_salesforce,
       w.written_at
from public.contractor_invoice_line l
join public.contractor_invoice i on i.id = l.invoice_id
left join public.staffing_snapshot s on s.staffing_sf_id = l.staffing_sf_id
left join public.staffing_snapshot t on t.staffing_sf_id = l.target_staffing_sf_id
left join public.v_contractor_written w on w.staffing_sf_id = l.target_staffing_sf_id;
grant select on public.v_app_contractor_line to authenticated;

-- Every invoice, with how many of its Day 1 records are already in Salesforce.
create or replace view public.v_app_contractor_invoice_all with (security_invoker = on) as
select i.id as invoice_id, i.contact_sf_id, i.vendor_name, i.invoice_no, i.invoice_date,
       i.subtotal_cents, i.total_cents, i.lines_cents, i.hours, i.math_ok, i.problems, i.status,
       i.loaded_at, i.approved_by, i.approved_at,
       count(l.id) as lines,
       count(l.target_staffing_sf_id) as matched_lines,
       count(*) filter (where l.match_note is not null) as lines_to_check,
       count(distinct l.target_staffing_sf_id) as records,
       count(distinct l.target_staffing_sf_id) filter (where w.in_salesforce) as written_records,
       i.status = 'approved' and count(l.id) > 0 and bool_and(coalesce(w.in_salesforce, false)) as in_salesforce,
       max(w.written_at) as written_at
from public.contractor_invoice i
left join public.contractor_invoice_line l on l.invoice_id = i.id
left join public.v_contractor_written w on w.staffing_sf_id = l.target_staffing_sf_id
group by i.id;
grant select on public.v_app_contractor_invoice_all to authenticated;

-- What the Wages tab reads: everything not yet fully in Salesforce.
drop view if exists public.v_app_contractor_invoice;
create view public.v_app_contractor_invoice with (security_invoker = on) as
select * from public.v_app_contractor_invoice_all where not in_salesforce;
grant select on public.v_app_contractor_invoice to authenticated;
