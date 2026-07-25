-- 016_draft_outcomes_v2.sql
-- Rebuild the outcomes scoreboard so its numbers stop lying (redesign M1):
--   * JOIN INFLATION FIX: the old view left-joined touch_edits before
--     aggregating, so a touch with N edits counted N times in drafted/sent/
--     replied/bounced. Edits now aggregate in a subquery.
--   * TRACK DIMENSION: per-audience (msp vs customer) comparison — the
--     business's core A/B — becomes computable.
--   * DISPOSITION COLUMNS: positive_replied counts touches whose captured
--     reply was triaged 'positive' (interactions.touch_id + disposition,
--     migration 015). Raw replied still shown; positive is the honest signal.
--   * SOFT-DELETE AWARE: killed drafts leave the funnel.
-- Bounces remain in the sent denominator deliberately: a bounce consumed a
-- send slot and reputation; excluding it would flatter reply_rate.

drop view if exists public.draft_outcomes;

create or replace view public.draft_outcomes
with (security_invoker = on) as
with edit_counts as (
  select touch_id, count(*) as edit_count
  from public.touch_edits
  group by touch_id
),
reply_dispositions as (
  select touch_id,
         bool_or(disposition = 'positive')  as has_positive,
         bool_or(disposition = 'opt_out')   as has_opt_out
  from public.interactions
  where touch_id is not null and disposition is not null
  group by touch_id
)
select
  t.prompt_version_id,
  pv.module,
  pv.version,
  t.channel,
  t.track,
  count(*)                                                    as drafted,
  count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                      or t.sent_at is not null)               as sent,
  count(*) filter (where t.status = 'replied')                as replied,
  count(*) filter (where rd.has_positive)                     as positive_replied,
  count(*) filter (where rd.has_opt_out)                      as opted_out,
  count(*) filter (where t.status = 'bounced')                as bounced,
  count(*) filter (where t.status = 'failed')                 as failed,
  count(*) filter (where ec.touch_id is not null)             as edited,
  round(
    count(*) filter (where t.status = 'replied')::numeric
      / nullif(count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                                   or t.sent_at is not null), 0),
    4)                                                        as reply_rate,
  round(
    count(*) filter (where rd.has_positive)::numeric
      / nullif(count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                                   or t.sent_at is not null), 0),
    4)                                                        as positive_reply_rate,
  min(t.sent_at)                                              as first_sent_at,
  max(t.sent_at)                                              as last_sent_at
from public.touches t
left join public.prompt_versions pv on pv.id = t.prompt_version_id
left join edit_counts ec on ec.touch_id = t.id
left join reply_dispositions rd on rd.touch_id = t.id
where t.direction = 'outbound'
  and t.deleted_at is null
group by t.prompt_version_id, pv.module, pv.version, t.channel, t.track;
