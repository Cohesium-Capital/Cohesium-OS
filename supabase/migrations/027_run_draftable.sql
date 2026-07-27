-- 027_run_draftable.sql
-- Rejected drafts have to come back.
--
-- Sending a draft back to drafting soft-deletes it, which already frees the
-- contact: the global draftable count picks it up immediately, because
-- eligibility ignores soft-deleted touches. The run view did not. It reasons
-- from stage totals, and its ladder only offers Draft once personalized >
-- drafted — so a run whose contacts carry no hooks (personalized = 0) sits on
-- "Personalize" indefinitely while rejected drafts wait, invisible.
--
-- flow_runs now carries the two numbers that make the run view agree with the
-- rest of the app:
--   draftable         contacts of this run that /draft would offer right now
--   awaiting_redraft  the subset the operator explicitly sent back
--
-- Both use the same eligibility rule as lib/journey.ts, so the run-scoped view
-- and the global count can never disagree about who is ready to draft.

create or replace view public.flow_runs
with (security_invoker = on) as
with hooked as (
  select distinct contact_id from public.hooks where status <> 'rejected'
),
contact_funnel_by_run as (
  select
    c.run_id                                                        as key,
    count(*) filter (where c.deleted_at is null)                    as sourced,
    count(*) filter (where c.deleted_at is not null)                as discarded,
    count(*) filter (where c.deleted_at is null and c.reviewed)     as reviewed,
    count(*) filter (where c.deleted_at is null
                       and c.enrichment_status = 'enriched')        as enriched,
    count(*) filter (where c.deleted_at is null
                       and (hk.contact_id is not null
                            or (c.personalization is not null
                                and length(btrim(c.personalization)) > 0)))  as personalized
  from public.contacts c
  left join hooked hk on hk.contact_id = c.id
  where c.run_id is not null
  group by c.run_id
),
contact_funnel_by_batch as (
  select
    c.batch_id                                                      as key,
    count(*) filter (where c.deleted_at is null)                    as sourced,
    count(*) filter (where c.deleted_at is not null)                as discarded,
    count(*) filter (where c.deleted_at is null and c.reviewed)     as reviewed,
    count(*) filter (where c.deleted_at is null
                       and c.enrichment_status = 'enriched')        as enriched,
    count(*) filter (where c.deleted_at is null
                       and (hk.contact_id is not null
                            or (c.personalization is not null
                                and length(btrim(c.personalization)) > 0)))  as personalized
  from public.contacts c
  left join hooked hk on hk.contact_id = c.id
  where c.batch_id is not null
  group by c.batch_id
),
touch_funnel_by_run as (
  select
    c.run_id                                                        as key,
    count(distinct t.contact_id) filter (where t.deleted_at is null) as drafted,
    count(distinct t.contact_id) filter (
      where t.status in ('sent','delivered','replied','bounced')
         or t.sent_at is not null)                                   as sent,
    count(distinct t.contact_id) filter (where t.status = 'replied')  as replied
  from public.contacts c
  join public.touches t
    on t.contact_id = c.id and t.direction = 'outbound'
  where c.run_id is not null and c.deleted_at is null
  group by c.run_id
),
touch_funnel_by_batch as (
  select
    c.batch_id                                                      as key,
    count(distinct t.contact_id) filter (where t.deleted_at is null) as drafted,
    count(distinct t.contact_id) filter (
      where t.status in ('sent','delivered','replied','bounced')
         or t.sent_at is not null)                                   as sent,
    count(distinct t.contact_id) filter (where t.status = 'replied')  as replied
  from public.contacts c
  join public.touches t
    on t.contact_id = c.id and t.direction = 'outbound'
  where c.batch_id is not null and c.deleted_at is null
  group by c.batch_id
),
-- Contacts of this run that /draft would currently offer, using the same
-- eligibility rule as lib/journey.ts: an address, a passed gate, no live
-- planned draft already claiming them, not suppressed.
--
-- awaiting_redraft is the subset the operator explicitly rejected: a draft was
-- sent back to drafting (soft-deleted, reason 'redraft'), which frees the
-- contact — but until this column existed, nothing in the run view said so, and
-- a run whose contacts have no hooks would sit on "Personalize" forever while
-- rejected drafts waited unseen.
draftable_by_run as (
  select
    c.run_id                                                          as key,
    count(*) filter (where (c.email is not null or c.linkedin_url is not null)
                       and (c.batch_id is null or b.gate_status = 'passed')
                       and not exists (select 1 from public.touches t
                                        where t.contact_id = c.id and t.direction = 'outbound'
                                          and t.status = 'planned' and t.deleted_at is null)
                       and not exists (select 1 from public.suppressions s
                                        where s.contact_id = c.id
                                          and s.status in ('active','pending')))                                  as draftable,
    count(*) filter (where (c.email is not null or c.linkedin_url is not null)
                       and (c.batch_id is null or b.gate_status = 'passed')
                       and not exists (select 1 from public.touches t
                                        where t.contact_id = c.id and t.direction = 'outbound'
                                          and t.status = 'planned' and t.deleted_at is null)
                       and not exists (select 1 from public.suppressions s
                                        where s.contact_id = c.id
                                          and s.status in ('active','pending')) and exists (select 1 from public.touches t
                                        where t.contact_id = c.id
                                          and t.delete_reason = 'redraft'
                                          and t.deleted_at is not null))                  as awaiting_redraft
  from public.contacts c
  left join public.batches b on b.id = c.batch_id
  where c.run_id is not null and c.deleted_at is null
  group by c.run_id
),
draftable_by_batch as (
  select
    c.batch_id                                                        as key,
    count(*) filter (where (c.email is not null or c.linkedin_url is not null)
                       and (c.batch_id is null or b.gate_status = 'passed')
                       and not exists (select 1 from public.touches t
                                        where t.contact_id = c.id and t.direction = 'outbound'
                                          and t.status = 'planned' and t.deleted_at is null)
                       and not exists (select 1 from public.suppressions s
                                        where s.contact_id = c.id
                                          and s.status in ('active','pending')))                                  as draftable,
    count(*) filter (where (c.email is not null or c.linkedin_url is not null)
                       and (c.batch_id is null or b.gate_status = 'passed')
                       and not exists (select 1 from public.touches t
                                        where t.contact_id = c.id and t.direction = 'outbound'
                                          and t.status = 'planned' and t.deleted_at is null)
                       and not exists (select 1 from public.suppressions s
                                        where s.contact_id = c.id
                                          and s.status in ('active','pending')) and exists (select 1 from public.touches t
                                        where t.contact_id = c.id
                                          and t.delete_reason = 'redraft'
                                          and t.deleted_at is not null))                  as awaiting_redraft
  from public.contacts c
  left join public.batches b on b.id = c.batch_id
  where c.batch_id is not null and c.deleted_at is null
  group by c.batch_id
),
own_drafts as (
  select
    t.run_id                                                        as key,
    count(*) filter (where t.deleted_at is null)                    as drafts_created
  from public.touches t
  where t.run_id is not null and t.direction = 'outbound'
  group by t.run_id
)
select
  'run'::text                          as entry_kind,
  r.id                                 as id,
  r.batch_id                           as batch_id,
  r.module                             as module,
  r.status                             as status,
  r.executor                           as executor,
  r.provider_label                     as provider_label,
  r.config                             as config,
  r.error                              as error,
  r.created_at                         as created_at,
  r.finished_at                        as finished_at,
  bs.label                             as batch_label,
  bs.gate_status                       as gate_status,
  coalesce(bs.sampled, 0)              as sampled,
  coalesce(bs.graded, 0)               as graded,
  coalesce(bs.errors, 0)               as errors,
  coalesce(bs.pending, 0)              as pending,
  coalesce(cf.sourced, cfb.sourced, 0)           as sourced,
  coalesce(cf.discarded, cfb.discarded, 0)       as discarded,
  coalesce(cf.reviewed, cfb.reviewed, 0)         as reviewed,
  coalesce(cf.enriched, cfb.enriched, 0)         as enriched,
  coalesce(cf.personalized, cfb.personalized, 0) as personalized,
  coalesce(tf.drafted, tfb.drafted, 0)           as drafted,
  coalesce(tf.sent, tfb.sent, 0)                 as sent,
  coalesce(tf.replied, tfb.replied, 0)           as replied,
  coalesce(od.drafts_created, 0)                 as drafts_created,
  r.seq                                          as run_seq,
  public.run_mode_code(r.module, r.config)       as run_mode_code,
  r.seq || '-' || public.run_mode_code(r.module, r.config) as run_code,
  (coalesce(cf.sourced, cfb.sourced, 0) > 0
     or coalesce(od.drafts_created, 0) > 0)      as has_records,
  -- Appended, not inserted: create or replace view can only add columns at the
  -- end of the list.
  coalesce(df.draftable, dfb2.draftable, 0)      as draftable,
  coalesce(df.awaiting_redraft, dfb2.awaiting_redraft, 0) as awaiting_redraft
from public.runs r
left join public.batch_stats bs        on bs.id = r.batch_id
left join contact_funnel_by_run cf     on cf.key = r.id
left join touch_funnel_by_run tf       on tf.key = r.id
left join contact_funnel_by_batch cfb  on cfb.key = r.batch_id
left join touch_funnel_by_batch tfb    on tfb.key = r.batch_id
left join own_drafts od                on od.key = r.id
left join draftable_by_run df          on df.key = r.id
left join draftable_by_batch dfb2      on dfb2.key = r.batch_id

union all

select
  'batch'::text,        -- entry_kind
  bs.id,                -- id
  bs.id,                -- batch_id
  bs.module,            -- module
  'review_ready'::text, -- status
  null::text,           -- executor
  null::text,           -- provider_label
  '{}'::jsonb,          -- config
  null::text,           -- error
  bs.created_at,        -- created_at
  null::timestamptz,    -- finished_at
  bs.label,             -- batch_label
  bs.gate_status,       -- gate_status
  coalesce(bs.sampled, 0),
  coalesce(bs.graded, 0),
  coalesce(bs.errors, 0),
  coalesce(bs.pending, 0),
  coalesce(cf.sourced, 0),
  coalesce(cf.discarded, 0),
  coalesce(cf.reviewed, 0),
  coalesce(cf.enriched, 0),
  coalesce(cf.personalized, 0),
  coalesce(tf.drafted, 0),
  coalesce(tf.sent, 0),
  coalesce(tf.replied, 0),
  0::bigint,
  null::bigint,                       -- run_seq: a batch with no run has no identifier
  null::text,                         -- run_mode_code
  null::text,                         -- run_code
  coalesce(cf.sourced, 0) > 0,        -- has_records
  coalesce(dfb.draftable, 0),
  coalesce(dfb.awaiting_redraft, 0)
from public.batch_stats bs
left join contact_funnel_by_batch cf on cf.key = bs.id
left join touch_funnel_by_batch tf   on tf.key = bs.id
left join draftable_by_batch dfb     on dfb.key = bs.id
where not exists (select 1 from public.runs r where r.batch_id = bs.id)

union all

select
  'import'::text,
  sr.id,
  null::uuid,
  'sourcing'::text,
  'review_ready'::text,
  'direct_import'::text,
  null::text,
  jsonb_build_object(
    'mode', case when sr.kind = 'msp' then 'research_msps' else 'research_customers' end,
    'kind', sr.kind,
    'targetMspId', sr.target_msp_id,
    'msps', case
              when sr.target_msp_id is null then '[]'::jsonb
              else jsonb_build_array(jsonb_build_object(
                     'id', sr.target_msp_id,
                     'name', coalesce((select o.name from public.organizations o
                                        where o.id = sr.target_msp_id), 'unknown MSP')))
            end
  ),
  null::text,
  sr.created_at,
  sr.created_at,
  null::text,
  null::text,
  0::bigint, 0::bigint, 0::bigint, 0::bigint,
  sr.inserted_contacts::bigint,
  0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
  0::bigint,
  null::bigint,                       -- run_seq
  null::text,                         -- run_mode_code
  null::text,                         -- run_code
  false,                              -- has_records: counts only, no rows to open
  0::bigint,                          -- draftable
  0::bigint                           -- awaiting_redraft
from public.sourcing_runs sr
where sr.run_id is null;

-- ---------- 5. company_list ← the run that first sourced each company ----------
-- A company can be touched by several runs (a later run finds another contact
-- there); the FIRST one is the useful attribution — it answers "where did this
-- company come from". Companies imported before run tracking have none.

create or replace view public.company_list
with (security_invoker = on) as
select
  o.id,
  o.name,
  o.domain,
  o.kind,
  o.is_acq_target,
  o.confidence,
  o.reviewed,
  o.hq_city,
  o.hq_state,
  o.current_msp_id,
  m.name                                                              as current_msp_name,
  count(ct.id) filter (where ct.deleted_at is null)                   as contacts,
  count(ct.id) filter (where ct.deleted_at is null and ct.reviewed)   as contacts_reviewed,
  count(ct.id) filter (where ct.deleted_at is null
                         and ct.enrichment_status = 'enriched')       as contacts_enriched,
  o.created_at                                                        as added_at,
  fr.run_id                                                           as first_run_id,
  fr.run_code                                                         as first_run_code,
  fr.run_at                                                           as first_run_at
from public.organizations o
left join public.organizations m on m.id = o.current_msp_id
left join public.contacts ct     on ct.organization_id = o.id
left join lateral (
  select cr.run_id, cr.run_code, cr.run_at
    from public.contacts c2
    join public.contact_runs cr on cr.contact_id = c2.id
   where c2.organization_id = o.id
   order by cr.run_at, cr.run_code
   limit 1
) fr on true
group by o.id, m.name, fr.run_id, fr.run_code, fr.run_at;
