-- 006_msp_stats_view.sql
-- Aggregate MSP coverage in the database instead of pulling every customer and
-- contact into the app (which breaks past ~1000 rows). security_invoker = on so
-- the view respects the querying user's RLS. The dashboard queries this with
-- search (ilike on name) + range pagination.
--
-- status: a single targeted run that added 0 new customers => 'exhausted'; any
-- targeted run that added new => 'productive'; no targeted run yet => 'unexplored'.
-- status_rank orders actionable MSPs first.

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
  end                                               as status_rank
from public.organizations m
left join public.organizations c
  on c.current_msp_id = m.id and c.kind = 'customer'
left join public.contacts ct
  on ct.organization_id = c.id
left join run_counts rc on rc.target_msp_id = m.id
left join last_run lr on lr.target_msp_id = m.id
where m.kind = 'msp'
group by m.id, rc.targeted_runs, lr.new_for_target;
