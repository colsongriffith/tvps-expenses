-- Applied 28 Oct 2026 as migrations "expected_rate_line_manager_roles" (superseded) and "expected_rate_by_gig_service".
-- Colson: on a Headshot or TVPS gig, crew are paid their Headshot / TVPS Status for the whole gig, whatever role
-- they start in (line managers rotate onto the camera on long days).
-- Headshot Line Manager, Virtual Headshot Guide -> Headshot Status. Line Manager -> Headshot Status when the event
-- name says Headshot, otherwise TVPS Status. Roles with no status (Marketing Content Creator, SpotMyPhotos Spotter,
-- Drone Operator) still use the Contact's Hourly Rate.

drop function if exists public.expected_rate_cents(text, text, text, text);

create function public.expected_rate_cents(p_role text, p_bucket text, p_contact text, p_staffing text)
 returns bigint language sql stable set search_path to 'public'
as $function$
  select case
    when p_bucket = 'admin' then 2500   -- Admin/Commute is $25/hr across the board
    else coalesce(
      (select case s
         when 'In Training' then 5000 when 'Lead' then 6000 when 'Senior' then 7500 end
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

create or replace function public.expected_rate_cents(p_role text, p_bucket text, p_contact text)
 returns bigint language sql stable set search_path to 'public'
as $function$ select public.expected_rate_cents(p_role, p_bucket, p_contact, null::text) $function$;

do $$
declare v text; d text; opts text;
begin
  foreach v in array array['v_wage_queue','v_app_wage_rate_flag','v_app_timesheet_issue'] loop
    d := pg_get_viewdef(('public.' || v)::regclass);
    d := replace(d, 'expected_rate_cents(c.role, (c.bucket)::text, c.contact_sf_id)', 'expected_rate_cents(c.role, (c.bucket)::text, c.contact_sf_id, c.staffing_sf_id)');
    d := replace(d, 'expected_rate_cents(ss.role, (wa.bucket)::text, ss.contact_sf_id)', 'expected_rate_cents(ss.role, (wa.bucket)::text, ss.contact_sf_id, ss.staffing_sf_id)');
    d := regexp_replace(d, ';\s*$', '');
    select coalesce(' with (' || array_to_string(reloptions, ', ') || ')', '') into opts from pg_class where oid = ('public.' || v)::regclass;
    execute 'create or replace view public.' || v || opts || ' as ' || d;
  end loop;
end $$;
