-- TVPS Contractors are paid by invoice, never by timesheet (Colson, 4 Nov 2026: Viktoria Romanova).
-- Before this, contractors were only skipped when hard-coded in is_salaried() (Christina Dugdale).
-- Now the missing-timesheet list skips anyone whose Salesforce Contact.Contact_Type__c is 'TVPS Contractor'.
-- sf_contact_pay gains contact_type; the Gusto sweep's Salesforce pull refreshes it for staffed contacts.

alter table sf_contact_pay add column if not exists contact_type text;

update sf_contact_pay set contact_type = 'TVPS Contractor'
 where contact_sf_id in ('003VX00001AJqmDYAT',  -- Viktoria Romanova
                         '0035a00003C7SOlAAN',  -- Christina Dugdale
                         '0030b00002NX3dcAAD',  -- Katherine Rose
                         '003VX00000TW1JfYAL'); -- Keoni Watson

create or replace view v_app_missing_timesheet as
 WITH cover AS (
         SELECT max(wage_shift.work_date) AS through,
            min(wage_shift.work_date) AS since
           FROM wage_shift
        ), s AS (
         SELECT ss.contact_sf_id,
            ss.event_date,
            string_agg(((ss.role || ' · '::text) || ss.opportunity_name), ' | '::text ORDER BY ss.opportunity_name) AS what,
            bool_and(is_remote_role(ss.role)) AS remote_only,
            array_agg(ss.staffing_sf_id) AS staffing_ids,
            min(ss.opportunity_sf_id) AS opportunity_sf_id
           FROM staffing_snapshot ss,
            cover
          WHERE ((ss.contact_sf_id IS NOT NULL) AND is_wage_stage(ss.stage) AND (ss.event_date < CURRENT_DATE) AND (ss.opportunity_name !~~* '%quarterly meeting%'::text) AND (ss.event_date >= GREATEST(cover.since, ( SELECT ((app_config.value #>> '{}'::text[]))::date AS date
                   FROM app_config
                  WHERE (app_config.key = 'wage_sync_from_event_date'::text)))) AND (ss.event_date <= cover.through))
          GROUP BY ss.contact_sf_id, ss.event_date
        )
 SELECT s.contact_sf_id,
    COALESCE(c.full_name, p.full_name) AS full_name,
    c.email,
    s.event_date,
    s.what,
    s.remote_only,
    s.opportunity_sf_id,
    ( SELECT string_agg(DISTINCT to_char((ws.work_date)::timestamp with time zone, 'Mon DD'::text), ', '::text) AS string_agg
           FROM wage_shift ws
          WHERE ((ws.person_id = p.id) AND (ws.work_date >= (s.event_date - 3)) AND (ws.work_date <= (s.event_date + 3)))) AS gusto_nearby,
    (NOT (EXISTS ( SELECT 1
           FROM wage_shift ws
          WHERE (ws.person_id = p.id)))) AS no_gusto_record,
    ( SELECT r.status
           FROM timesheet_reminder r
          WHERE ((r.contact_sf_id = s.contact_sf_id) AND (r.event_date = s.event_date))
          ORDER BY r.requested_at DESC
         LIMIT 1) AS reminder_status,
    ( SELECT cover.through
           FROM cover) AS gusto_through
   FROM ((s
     LEFT JOIN sf_contact_pay c ON ((c.contact_sf_id = s.contact_sf_id)))
     LEFT JOIN person p ON ((p.contact_sf_id = s.contact_sf_id)))
  WHERE ((NOT is_salaried(COALESCE(c.full_name, p.full_name)))
    AND (COALESCE(c.contact_type, ''::text) <> 'TVPS Contractor'::text)
    AND (NOT (EXISTS ( SELECT 1
           FROM wage_shift ws
          WHERE ((ws.person_id = p.id) AND (ws.work_date = s.event_date)))))
    AND (NOT (EXISTS ( SELECT 1
           FROM wage_allocation wa
          WHERE (wa.active AND (wa.staffing_sf_id = ANY (s.staffing_ids)))))));
