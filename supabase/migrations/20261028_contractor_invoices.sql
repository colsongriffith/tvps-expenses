-- Contractor invoices (Christina Dugdale, Event Photo Editor, invoices monthly).
-- Colson, 28 Oct 2026: check the invoice math, map each line to her staffing record for that event, and roll
-- multi-day programs up so the whole amount goes on the Day 1 record (On-Site Wages only, as before).
-- Programs without day labels roll up too (CITGO Wave 1/2, Turn/River All-In).
--
-- Flow: Claude parses the PDF (tools/contractor-invoice/parse_invoice.py) -> contractor_invoice_load(json)
-- matches every line and proposes the Day 1 record -> an editor checks it on the Wages tab and presses
-- Approve -> the totals join the wage queue and the normal wage sync writes On_Site_Wages__c.

create table if not exists public.contractor_invoice (
  id uuid primary key default gen_random_uuid(),
  contact_sf_id text not null,
  vendor_name text not null,
  invoice_no text not null,
  invoice_date date,
  subtotal_cents bigint,
  total_cents bigint not null,
  lines_cents bigint not null,
  hours numeric,
  math_ok boolean not null,
  problems jsonb not null default '[]',
  source_file text,
  status text not null default 'review' check (status in ('review','approved','void')),
  loaded_by text not null default 'claude',
  loaded_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  unique (contact_sf_id, invoice_no)
);

create table if not exists public.contractor_invoice_line (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.contractor_invoice(id) on delete cascade,
  line_no int not null,
  work_date date,
  description text not null,
  qty_hours numeric not null,
  unit_cents bigint not null,
  total_cents bigint not null,
  math_ok boolean not null,
  staffing_sf_id text,
  target_staffing_sf_id text,
  match_score int,
  match_note text,
  set_by text not null default 'matcher',
  set_at timestamptz not null default now(),
  unique (invoice_id, line_no)
);

alter table public.contractor_invoice enable row level security;
alter table public.contractor_invoice_line enable row level security;
revoke all on public.contractor_invoice, public.contractor_invoice_line from anon;
grant select on public.contractor_invoice, public.contractor_invoice_line to authenticated;
drop policy if exists app_member_read on public.contractor_invoice;
create policy app_member_read on public.contractor_invoice for select using (app_is_member());
drop policy if exists app_member_read on public.contractor_invoice_line;
create policy app_member_read on public.contractor_invoice_line for select using (app_is_member());

create or replace function public.opp_client_key(p_name text) returns text
language sql immutable as $$
  select lower(split_part(trim(split_part(regexp_replace(coalesce(p_name,''), '^\s*\([^)]*\)\s*', ''), ' - ', 2)), ' ', 1))
$$;
create or replace function public.opp_wave(p_name text) returns text
language sql immutable as $$ select substring(lower(coalesce(p_name,'')) from 'wave\s*(\d+)') $$;

create or replace function public.contractor_invoice_load(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_contact text := p->>'contact_sf_id';
  v_inv uuid;
  v_status text;
  l jsonb;
  c record;
  g record;
  v_grp int;
  v_out jsonb;
begin
  if v_contact is null then raise exception 'contact_sf_id is required'; end if;
  select id, status into v_inv, v_status from contractor_invoice where contact_sf_id = v_contact and invoice_no = p->>'invoice_no';
  if v_status = 'approved' then raise exception 'Invoice % is already approved; void it first to reload.', p->>'invoice_no'; end if;
  if v_inv is null then
    insert into contractor_invoice (contact_sf_id, vendor_name, invoice_no, invoice_date, subtotal_cents, total_cents,
      lines_cents, hours, math_ok, problems, source_file)
    values (v_contact, p->>'vendor', p->>'invoice_no', (p->>'invoice_date')::date, (p->>'subtotal_cents')::bigint,
      (p->>'total_cents')::bigint, (p->>'sum_lines_cents')::bigint, (p->>'hours')::numeric,
      jsonb_array_length(coalesce(p->'problems','[]')) = 0, coalesce(p->'problems','[]'), p->>'source_file')
    returning id into v_inv;
  else
    update contractor_invoice set vendor_name = p->>'vendor', invoice_date = (p->>'invoice_date')::date,
      subtotal_cents = (p->>'subtotal_cents')::bigint, total_cents = (p->>'total_cents')::bigint,
      lines_cents = (p->>'sum_lines_cents')::bigint, hours = (p->>'hours')::numeric,
      math_ok = jsonb_array_length(coalesce(p->'problems','[]')) = 0, problems = coalesce(p->'problems','[]'),
      source_file = p->>'source_file', status = 'review', loaded_at = now()
    where id = v_inv;
    with gone as (select 1) delete from contractor_invoice_line where invoice_id = v_inv;
  end if;

  for l in select * from jsonb_array_elements(p->'lines') loop
    c := null;
    select s.staffing_sf_id, s.opportunity_name, s.event_date,
           round(100 * word_similarity(lower(l->>'description'), lower(s.opportunity_name))
                 - 15 * abs(s.event_date - (l->>'date')::date)
                 + case when s.role ilike '%editor%' then 5 else 0 end)::int as score,
           (select count(*) from staffing_snapshot d where d.contact_sf_id = v_contact and d.opportunity_sf_id = s.opportunity_sf_id) as dup
      into c
      from staffing_snapshot s
     where s.contact_sf_id = v_contact and is_wage_stage(s.stage)
       and abs(s.event_date - (l->>'date')::date) <= 1
     order by 4 desc, s.staffing_sf_id
     limit 1;
    insert into contractor_invoice_line (invoice_id, line_no, work_date, description, qty_hours, unit_cents, total_cents,
      math_ok, staffing_sf_id, match_score, match_note)
    values (v_inv, (l->>'n')::int, (l->>'date')::date, l->>'description', (l->>'qty')::numeric,
      (l->>'unit_cents')::bigint, (l->>'total_cents')::bigint, coalesce((l->>'ok')::boolean, true),
      c.staffing_sf_id, c.score,
      case when c.staffing_sf_id is null then 'No staffing record for her within a day of this date.'
           else nullif(concat_ws(' ',
             case when c.score < 45 then 'Weak name match: check it.' end,
             case when c.event_date <> (l->>'date')::date then format('Salesforce has this event on %s.', to_char(c.event_date, 'Mon FMDD')) end,
             case when c.dup > 1 then format('She has %s staffing records on this event; the amount goes on one.', c.dup) end), '') end);
  end loop;

  create temp table if not exists _ci_grp (line_id uuid, grp int, client text, wave text, d date) on commit drop;
  with gone as (select 1) delete from _ci_grp;
  for g in
    select li.id, li.line_no, opp_client_key(s.opportunity_name) client, opp_wave(s.opportunity_name) wave, s.event_date
      from contractor_invoice_line li join staffing_snapshot s on s.staffing_sf_id = li.staffing_sf_id
     where li.invoice_id = v_inv order by s.event_date, li.line_no
  loop
    v_grp := null;
    select x.grp into v_grp from _ci_grp x
     where x.client = g.client and x.wave is not distinct from g.wave and g.event_date - x.d <= 4
     order by x.d desc limit 1;
    if v_grp is null then v_grp := coalesce((select max(y.grp) from _ci_grp y), 0) + 1; end if;
    insert into _ci_grp values (g.id, v_grp, g.client, g.wave, g.event_date);
  end loop;

  update contractor_invoice_line li set target_staffing_sf_id = t.target
    from (
      select x.line_id,
             (select s2.staffing_sf_id from staffing_snapshot s2
               where s2.contact_sf_id = v_contact and is_wage_stage(s2.stage)
                 and opp_client_key(s2.opportunity_name) = mx.client
                 and opp_wave(s2.opportunity_name) is not distinct from mx.wave
                 and s2.event_date between mx.start_d - 4 and mx.start_d
               order by s2.event_date, (s2.staffing_sf_id <> fl.staffing_sf_id), s2.staffing_sf_id limit 1) target
        from _ci_grp x
        join (select grp, min(client) client, min(wave) wave, min(d) start_d from _ci_grp group by grp) mx on mx.grp = x.grp
        cross join lateral (select li2.staffing_sf_id from _ci_grp y join contractor_invoice_line li2 on li2.id = y.line_id
                             where y.grp = x.grp order by y.d, li2.line_no limit 1) fl
    ) t
   where li.id = t.line_id;
  update contractor_invoice_line set target_staffing_sf_id = staffing_sf_id
   where invoice_id = v_inv and target_staffing_sf_id is null and staffing_sf_id is not null;

  select jsonb_build_object('invoice_id', v_inv,
           'lines', count(*), 'matched', count(staffing_sf_id), 'unmatched', count(*) - count(staffing_sf_id),
           'needs_a_look', count(*) filter (where match_note is not null),
           'targets', count(distinct target_staffing_sf_id))
    into v_out from contractor_invoice_line where invoice_id = v_inv;
  return v_out;
end $$;
revoke all on function public.contractor_invoice_load(jsonb) from public, anon, authenticated;

create or replace function public.contractor_line_set(p_line uuid, p_staffing text, p_target text)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_contact text;
begin
  if not app_is_editor() then raise exception 'Only editors can change invoice lines.'; end if;
  select i.status, i.contact_sf_id into v_status, v_contact from contractor_invoice i
    join contractor_invoice_line l on l.invoice_id = i.id where l.id = p_line;
  if v_status is distinct from 'review' then raise exception 'Only invoices in review can change.'; end if;
  if (p_staffing is not null and not exists (select 1 from staffing_snapshot where staffing_sf_id = p_staffing and contact_sf_id = v_contact))
     or (p_target is not null and not exists (select 1 from staffing_snapshot where staffing_sf_id = p_target and contact_sf_id = v_contact)) then
    raise exception 'That staffing record is not hers.';
  end if;
  update contractor_invoice_line set staffing_sf_id = p_staffing, target_staffing_sf_id = coalesce(p_target, p_staffing),
    set_by = app_current_email(), set_at = now(), match_note = null where id = p_line;
end $$;
revoke all on function public.contractor_line_set(uuid, text, text) from public, anon;
grant execute on function public.contractor_line_set(uuid, text, text) to authenticated;

create or replace function public.contractor_invoice_set_status(p_invoice uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app_is_editor() then raise exception 'Only editors can approve invoices.'; end if;
  if p_status not in ('review','approved') then raise exception 'Unknown status %', p_status; end if;
  if p_status = 'approved' and exists (select 1 from contractor_invoice_line where invoice_id = p_invoice and target_staffing_sf_id is null) then
    raise exception 'Every line needs a staffing record before the invoice can be approved.';
  end if;
  update contractor_invoice set status = p_status,
    approved_by = case when p_status = 'approved' then app_current_email() end,
    approved_at = case when p_status = 'approved' then now() end
  where id = p_invoice;
end $$;
revoke all on function public.contractor_invoice_set_status(uuid, text) from public, anon;
grant execute on function public.contractor_invoice_set_status(uuid, text) to authenticated;

create or replace view public.v_app_contractor_line with (security_invoker = on) as
select l.id as line_id, l.invoice_id, i.invoice_no, i.status as invoice_status, i.contact_sf_id, i.vendor_name,
       l.line_no, l.work_date, l.description, l.qty_hours, l.unit_cents, l.total_cents, l.math_ok,
       l.staffing_sf_id, s.opportunity_sf_id, s.opportunity_name, s.event_date, s.role,
       l.target_staffing_sf_id, t.opportunity_sf_id as target_opportunity_sf_id, t.opportunity_name as target_opportunity_name,
       t.event_date as target_event_date, l.match_score, l.match_note, l.set_by, l.set_at
  from contractor_invoice_line l
  join contractor_invoice i on i.id = l.invoice_id
  left join staffing_snapshot s on s.staffing_sf_id = l.staffing_sf_id
  left join staffing_snapshot t on t.staffing_sf_id = l.target_staffing_sf_id;
grant select on public.v_app_contractor_line to authenticated;

create or replace view public.v_app_contractor_invoice with (security_invoker = on) as
select i.id as invoice_id, i.contact_sf_id, i.vendor_name, i.invoice_no, i.invoice_date, i.subtotal_cents, i.total_cents,
       i.lines_cents, i.hours, i.math_ok, i.problems, i.status, i.loaded_at, i.approved_by, i.approved_at,
       count(l.id) as lines, count(l.target_staffing_sf_id) as matched_lines,
       count(*) filter (where l.match_note is not null) as lines_to_check,
       count(distinct l.target_staffing_sf_id) as records
  from contractor_invoice i left join contractor_invoice_line l on l.invoice_id = i.id
 group by i.id;
grant select on public.v_app_contractor_invoice to authenticated;

create or replace view public.v_contractor_wage with (security_invoker = on) as
select l.target_staffing_sf_id as staffing_sf_id,
       sum(l.total_cents)::bigint as on_site_wage_cents,
       sum(l.qty_hours) as invoiced_hours,
       count(distinct l.staffing_sf_id) as days,
       string_agg(distinct i.invoice_no, ', ') as invoices
  from contractor_invoice_line l join contractor_invoice i on i.id = l.invoice_id
 where i.status = 'approved' and l.target_staffing_sf_id is not null
 group by l.target_staffing_sf_id;
grant select on public.v_contractor_wage to authenticated;
