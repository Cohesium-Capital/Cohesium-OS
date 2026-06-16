-- 012_batch_stats_view.sql
-- Per-batch funnel + grading metrics for the Runs hub, aggregated in the DB so
-- the page never pulls every contact. security_invoker = on so the view respects
-- the querying user's RLS. provenance is the producing run's executor label
-- (copy-paste today; subscription:model once the runner lands).

create or replace view public.batch_stats
with (security_invoker = on) as
select
  b.id,
  b.module,
  b.label,
  b.gate_status,
  b.created_at,
  count(c.id)                                                                          as total,
  count(c.id) filter (where c.sampled)                                                 as sampled,
  count(c.id) filter (where c.sampled and c.review_status in ('approved','corrected','rejected')) as graded,
  count(c.id) filter (where c.sampled and c.review_status in ('corrected','rejected')) as errors,
  count(c.id) filter (where c.sampled and c.review_status = 'pending_review')          as pending,
  (select r.provider_label from public.runs r
     where r.batch_id = b.id order by r.created_at desc limit 1)                       as provenance
from public.batches b
left join public.contacts c on c.batch_id = b.id
group by b.id;
