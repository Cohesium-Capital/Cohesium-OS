-- 023_flow_runs_and_companies.sql
-- Two reporting surfaces, both aggregated in the database so the pages never
-- pull every contact:
--
--   1. flow_runs   — one row per run, with where that run's output currently
--                    sits in the pipeline (sourced → reviewed → enriched →
--                    personalized → drafted → sent). Drives the Runs timeline.
--   2. company_list — organizations with their estimated MSP, contact counts and
--                    the date they were added. Drives the Companies page.
--
-- Plus: msp_stats gains added_at, and sourcing_runs gains run_id so a yield-log
-- row can be tied back to the run that produced it (null = the legacy direct
-- import path, which predates run tracking).
--
-- Both views are security_invoker = on, so RLS applies to the querying user.

-- ---------- 0. sourcing_runs ← run attribution ----------

alter table public.sourcing_runs
  add column if not exists run_id uuid references public.runs(id);

create index if not exists sourcing_runs_run_idx on public.sourcing_runs (run_id);

-- Backfill: importPayload writes the yield-log row during the run's own ingest,
-- so a sourcing_runs row and its run are within a second of each other. Without
-- this, every historical run appears TWICE in flow_runs — once as its run, and
-- once as an 'import' entry from its own yield-log row — because run_id is null
-- on every row that predates the column.
--
-- Matched 1:1 and conservatively: nearest partner within 120s, agreeing on kind,
-- each side claimed at most once. Anything that does not match cleanly keeps a
-- null run_id and is correctly treated as a legacy direct import. Idempotent —
-- it only ever fills nulls.
with candidates as (
  select r.id as run_id, sr.id as sr_id,
         abs(extract(epoch from (coalesce(r.finished_at, r.created_at) - sr.created_at))) as secs
    from public.runs r
    join public.sourcing_runs sr
      on sr.run_id is null
     and sr.kind = coalesce(r.config->>'kind', sr.kind)
     and abs(extract(epoch from (coalesce(r.finished_at, r.created_at) - sr.created_at))) < 120
   where r.module = 'sourcing'
     -- A run already claimed by an earlier apply is off the table. Without this
     -- the statement is not stable under re-runs: the second-nearest log row
     -- would claim a run whose real partner was matched on the first pass.
     and not exists (
       select 1 from public.sourcing_runs claimed where claimed.run_id = r.id
     )
),
best_run_per_log as (
  select distinct on (sr_id) sr_id, run_id, secs from candidates order by sr_id, secs
),
one_to_one as (
  select distinct on (run_id) sr_id, run_id from best_run_per_log order by run_id, secs
)
update public.sourcing_runs sr
   set run_id = o.run_id
  from one_to_one o
 where sr.id = o.sr_id
   and sr.run_id is null;

-- ---------- 1. flow_runs ----------
-- Three kinds of entry, unioned so the page paginates in one query:
--   'run'    — a run row (today's path: every sourcing/drafting run)
--   'batch'  — a batch with no run (pre-run-tracking data; still gradeable, so
--              it must stay visible or its Grade entry point disappears)
--   'import' — a legacy direct import (/source/import), which recorded a
--              sourcing_runs row but never created a run or batch. Its contacts
--              carry no lineage, so the counts it can show are the ones the
--              import itself recorded.
--
-- Counts exclude soft-deleted rows; `discarded` reports the deleted ones
-- separately, because "42 sourced, 12 thrown away in review" is the useful
-- reading of a run, not a smaller sourced number with no explanation.

create or replace view public.flow_runs
with (security_invoker = on) as
-- Reaching the Personalize stage means the contact has a researched hook.
-- Migration 019 made hooks the stage's artifact; contacts.personalization is
-- the pre-019 column and nothing writes it any more, so it is kept only as a
-- fallback for any legacy row. An explicit kind='none' hook still counts — "no
-- hook found" is a real outcome of the stage — but a rejected one does not.
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
-- Draft/send progress is per contact, not per touch: a contact with three
-- drafted emails is one contact that reached the drafting stage.
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
-- What a drafting run itself produced (its output is touches, not contacts).
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
  -- Prefer run-level attribution, fall back to the run's batch. contacts.run_id
  -- only arrived in migration 015, so most historical contacts carry a batch_id
  -- and no run_id — without the fallback every older run reads as having
  -- produced nothing. The coalesce switches wholesale rather than per column:
  -- a run either has contact rows of its own or it does not.
  coalesce(cf.sourced, cfb.sourced, 0)           as sourced,
  coalesce(cf.discarded, cfb.discarded, 0)       as discarded,
  coalesce(cf.reviewed, cfb.reviewed, 0)         as reviewed,
  coalesce(cf.enriched, cfb.enriched, 0)         as enriched,
  coalesce(cf.personalized, cfb.personalized, 0) as personalized,
  coalesce(tf.drafted, tfb.drafted, 0)           as drafted,
  coalesce(tf.sent, tfb.sent, 0)                 as sent,
  coalesce(tf.replied, tfb.replied, 0)           as replied,
  coalesce(od.drafts_created, 0)                 as drafts_created
from public.runs r
left join public.batch_stats bs        on bs.id = r.batch_id
left join contact_funnel_by_run cf     on cf.key = r.id
left join touch_funnel_by_run tf       on tf.key = r.id
left join contact_funnel_by_batch cfb  on cfb.key = r.batch_id
left join touch_funnel_by_batch tfb    on tfb.key = r.batch_id
left join own_drafts od                on od.key = r.id

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
  0::bigint
from public.batch_stats bs
left join contact_funnel_by_batch cf on cf.key = bs.id
left join touch_funnel_by_batch tf   on tf.key = bs.id
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
  0::bigint
from public.sourcing_runs sr
where sr.run_id is null;

-- ---------- 2. company_list ----------
-- Every organization with the date it was added, its estimated MSP and how many
-- contacts it has. Serves both tracks: customers (with their MSP) and the MSPs /
-- acquisition targets themselves.

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
  o.created_at                                                        as added_at
from public.organizations o
left join public.organizations m on m.id = o.current_msp_id
left join public.contacts ct     on ct.organization_id = o.id
group by o.id, m.name;

-- ---------- 3. msp_stats ← added_at ----------
-- Appended at the end so the existing column order is unchanged (a requirement
-- of create or replace view). last_sourced is when this MSP's customers were
-- last added; added_at is when the MSP record itself appeared.

create or replace view public.msp_stats
with (security_invoker = on) as
with last_run as (
  select distinct on (target_msp_id)
    target_msp_id, new_for_target, created_at
  from public.sourcing_runs
  where target_msp_id is not null
  order by target_msp_id, created_at desc
),
run_counts as (
  select target_msp_id, count(*) as targeted_runs
  from public.sourcing_runs
  where target_msp_id is not null
  group by target_msp_id
)
select
  m.id,
  m.name,
  m.domain,
  m.confidence,
  m.reviewed,
  count(distinct c.id)                              as customers,
  count(distinct ct.id)                             as contacts,
  max(c.created_at)                                 as last_sourced,
  coalesce(rc.targeted_runs, 0)                     as targeted_runs,
  lr.new_for_target                                 as last_yield,
  case
    when coalesce(rc.targeted_runs, 0) = 0 then 'unexplored'
    when coalesce(lr.new_for_target, 0) = 0 then 'exhausted'
    else 'productive'
  end                                               as status,
  case
    when coalesce(rc.targeted_runs, 0) = 0 then 1   -- unexplored
    when coalesce(lr.new_for_target, 0) = 0 then 2  -- exhausted
    else 0                                          -- productive
  end                                               as status_rank,
  m.created_at                                      as added_at
from public.organizations m
left join public.organizations c
  on c.current_msp_id = m.id and c.kind = 'customer'
left join public.contacts ct
  on ct.organization_id = c.id
left join run_counts rc on rc.target_msp_id = m.id
left join last_run lr on lr.target_msp_id = m.id
where m.kind = 'msp'
group by m.id, rc.targeted_runs, lr.new_for_target;
