-- 024_run_identifiers.sql
-- Give every run a short identifier an operator can say out loud and search
-- for — "3-TCC" — and make each record traceable to the run that produced it.
--
-- The identifier is <seq>-<mode code>:
--   C    research_customers        — customers
--   T    research_msps             — target companies (MSPs)
--   TCC  find_customers_for_msps   — target company customers
--   P/D  personalization / drafting runs
--
-- seq is a stored column, not row_number() computed at read time: a run's
-- identifier must never change because an older run was deleted. Backfilled in
-- created_at order so existing runs keep their historical ordering.

-- ---------- 1. runs.seq ----------

alter table public.runs
  add column if not exists seq bigint;

create sequence if not exists public.runs_seq_seq;

with ordered as (
  select id, row_number() over (order by created_at, id) as rn
    from public.runs
)
update public.runs r
   set seq = o.rn
  from ordered o
 where o.id = r.id
   and r.seq is null;

select setval('public.runs_seq_seq', coalesce((select max(seq) from public.runs), 0) + 1, false);

alter table public.runs
  alter column seq set default nextval('public.runs_seq_seq');

alter sequence public.runs_seq_seq owned by public.runs.seq;

create unique index if not exists runs_seq_idx on public.runs (seq);

-- ---------- 2. mode code ----------
-- Reads the run's own config, so the code always describes what the run was
-- actually asked to do. Sourcing runs predating the mode field fall back to
-- their kind, which carries the same distinction for the two simple modes.

create or replace function public.run_mode_code(p_module text, p_config jsonb)
returns text
language sql
immutable
as $$
  select case
    when p_module = 'sourcing' then
      case coalesce(p_config->>'mode',
                    case when p_config->>'kind' = 'msp' then 'research_msps'
                         else 'research_customers' end)
        when 'research_customers'       then 'C'
        when 'research_msps'            then 'T'
        when 'find_customers_for_msps'  then 'TCC'
        else 'C'
      end
    when p_module = 'personalization' then 'P'
    when p_module = 'drafting'        then 'D'
    when p_module = 'enrichment'      then 'E'
    else 'R'
  end
$$;

comment on function public.run_mode_code(text, jsonb) is
  'Short mode code for a run identifier: C customers, T target companies, TCC target company customers, P personalization, D drafting, E enrichment.';

-- ---------- 3. contact_runs ----------
-- Each contact resolved to the run that produced it. Prefers contacts.run_id;
-- falls back to the run owning the contact's batch, because run_id only
-- arrived in migration 015 and most existing contacts carry a batch only.
-- One row per contact at most — the lateral picks a single run.

create or replace view public.contact_runs
with (security_invoker = on) as
select
  c.id                                                   as contact_id,
  r.id                                                   as run_id,
  r.seq                                                  as run_seq,
  public.run_mode_code(r.module, r.config)               as run_mode_code,
  r.seq || '-' || public.run_mode_code(r.module, r.config) as run_code,
  r.created_at                                           as run_at,
  r.module                                               as run_module
from public.contacts c
join lateral (
  select r.*
    from public.runs r
   where r.id = c.run_id
      or (c.run_id is null and c.batch_id is not null and r.batch_id = c.batch_id)
   -- Direct run attribution wins; otherwise the batch's earliest run.
   order by (r.id = c.run_id) desc, r.created_at
   limit 1
) r on true;

-- ---------- 4. flow_runs ← identifier + record count ----------
-- Adds run_seq / run_mode_code / run_code, plus has_records so the Runs page
-- can hide runs that never produced anything (a prompt generated but never
-- pasted back) without the page having to guess which counts matter per module.

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
     or coalesce(od.drafts_created, 0) > 0)      as has_records
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
  0::bigint,
  null::bigint,                       -- run_seq: a batch with no run has no identifier
  null::text,                         -- run_mode_code
  null::text,                         -- run_code
  coalesce(cf.sourced, 0) > 0         -- has_records
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
  0::bigint,
  null::bigint,                       -- run_seq
  null::text,                         -- run_mode_code
  null::text,                         -- run_code
  false                               -- has_records: counts only, no rows to open
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
