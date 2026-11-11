-- Per-person exceptions to the standard status rates (In Training $50, Lead $60, Senior $75).
-- Colson, 11 Nov 2026: Erin Bump's Sr. Photographer rate is $80/hr. That is correct, not a wrong_rate.
-- The override applies to on-site work only. Admin/Commuting stays $25 for everyone,
-- so an admin/commute shift entered at the wrong rate is still flagged.
-- expected_rate_cents() also prices v_wage_queue, so this makes the Salesforce
-- On-Site Wages for Erin use $80 instead of $75.

create table if not exists public.person_rate_override (
  contact_sf_id text not null,
  -- '*' = applies whatever the status (used when the contact has no statuses in Salesforce)
  status text not null default '*' check (status in ('In Training','Lead','Senior','*')),
  rate_cents bigint not null check (rate_cents > 0),
  note text,
  decided_by text,
  created_at timestamptz not null default now(),
  primary key (contact_sf_id, status)
);
alter table public.person_rate_override enable row level security;
drop policy if exists app_member_read on public.person_rate_override;
create policy app_member_read on public.person_rate_override for select using (app_is_member());

insert into public.person_rate_override (contact_sf_id, status, rate_cents, note, decided_by)
values ('0035a00002msrNkAAI', 'Senior', 8000,
        'Erin Bump: unique Sr. Photographer rate $80/hr (Colson, 11 Nov 2026). On-site only; admin/commute still $25.',
        'colson@thevanityportraitstudio.com')
on conflict (contact_sf_id, status) do update set rate_cents = excluded.rate_cents, note = excluded.note;

-- Alex Akamine: unique on-site rate, taken from Gusto (Colson, 11 Nov 2026).
-- Gusto "Lead Photographer - On-Site Rate" = $125/hr. His Salesforce statuses are blank,
-- so this applies whatever the status, and replaces the $150 Salesforce Hourly Rate fallback.
insert into public.person_rate_override (contact_sf_id, status, rate_cents, note, decided_by)
values ('0035a00002hK9JBAA0', '*', 12500,
        'Alex Akamine: unique on-site rate $125/hr, from Gusto (Colson, 11 Nov 2026). On-site only; admin/commute still $25.',
        'colson@thevanityportraitstudio.com')
on conflict (contact_sf_id, status) do update set rate_cents = excluded.rate_cents, note = excluded.note;

create or replace function public.expected_rate_cents(p_role text, p_bucket text, p_contact text, p_staffing text)
 returns bigint
 language sql
 stable
 set search_path to 'public'
as $function$
  select case
    when p_bucket = 'admin' then 2500   -- Admin/Commute is $25/hr across the board (no exceptions)
    else coalesce(
      (select coalesce(
                (select o.rate_cents from person_rate_override o
                  where o.contact_sf_id = p_contact and o.status = x.s),
                (select o.rate_cents from person_rate_override o
                  where o.contact_sf_id = p_contact and o.status = '*'),
                case x.s when 'In Training' then 5000 when 'Lead' then 6000 when 'Senior' then 7500 end)
       from (select case
               when p_role in ('TVPS Photographer','Editor','Print Manager') then c.tvps_status
               when p_role in ('Headshot Photographer','Headshot Editor','Headshot Line Manager','Virtual Headshot Guide') then c.headshot_status
               when p_role = 'Line Manager' then case
                 when (select ss.opportunity_name from staffing_snapshot ss where ss.staffing_sf_id = p_staffing) ilike '%headshot%'
                 then c.headshot_status else c.tvps_status end
               when p_role in ('Event Photographer','Event Photo Editor') then c.event_status
               when p_role in ('Videographer','Video Editor') then c.video_status
             end s from sf_contact_pay c where c.contact_sf_id = p_contact) x),
      (select hourly_cents from sf_contact_pay where contact_sf_id = p_contact))
  end
$function$;
