-- 040_outcome_views_workspace_scope.sql
--
-- Migration 030 established the rule: "the application cannot scope what the
-- view does not expose — so every view a page reads now carries workspace_id."
-- Three views predating tenancy were missed: draft_outcomes (016),
-- hook_outcomes (019) and prompt_rule_outcomes (025). For a member of two
-- workspaces their aggregates summed across tenants with no column to filter
-- on, and prompt_rule_outcomes went further: its rules-to-versions join was on
-- module + time window alone, so workspace A's rules were scored against
-- workspace B's draft outcomes.
--
-- Each view gains workspace_id as its LAST column (create or replace can only
-- append) and groups by it. prompt_rule_outcomes' join also becomes
-- workspace-consistent.

-- ---------- draft_outcomes ----------
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
  max(t.sent_at)                                              as last_sent_at,
  t.workspace_id
from public.touches t
left join public.prompt_versions pv on pv.id = t.prompt_version_id
left join edit_counts ec on ec.touch_id = t.id
left join reply_dispositions rd on rd.touch_id = t.id
where t.direction = 'outbound'
  and t.deleted_at is null
group by t.prompt_version_id, pv.module, pv.version, t.channel, t.track, t.workspace_id;

-- ---------- hook_outcomes ----------
create or replace view public.hook_outcomes
with (security_invoker = on) as
with reply_dispositions as (
  select touch_id,
         bool_or(disposition = 'positive') as has_positive
  from public.interactions
  where touch_id is not null and disposition is not null
  group by touch_id
)
select
  coalesce(h.kind, 'no_hook')                                 as hook_kind,
  t.track,
  count(*)                                                    as drafted,
  count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                      or t.sent_at is not null)               as sent,
  count(*) filter (where t.status = 'replied')                as replied,
  count(*) filter (where rd.has_positive)                     as positive_replied,
  round(
    count(*) filter (where rd.has_positive)::numeric
      / nullif(count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                                   or t.sent_at is not null), 0),
    4)                                                        as positive_reply_rate,
  t.workspace_id
from public.touches t
left join public.hooks h on h.id = t.hook_id
left join reply_dispositions rd on rd.touch_id = t.id
where t.direction = 'outbound'
  and t.deleted_at is null
group by coalesce(h.kind, 'no_hook'), t.track, t.workspace_id;

-- ---------- prompt_rule_outcomes ----------
-- The join gains pv.workspace_id = r.workspace_id: a rule rides the prompt
-- versions OF ITS OWN WORKSPACE, and draft_outcomes rows (now per workspace)
-- are matched on the version id, whose workspace agrees by construction.
create or replace view public.prompt_rule_outcomes
with (security_invoker = on) as
select
  r.id                                as rule_id,
  r.module,
  r.rule_text,
  r.status,
  r.support_count,
  r.activated_at,
  coalesce(sum(o.drafted), 0)         as drafted_since,
  coalesce(sum(o.sent), 0)            as sent_since,
  coalesce(sum(o.replied), 0)         as replied_since,
  coalesce(sum(o.edited), 0)          as edited_since,
  case when coalesce(sum(o.drafted), 0) > 0
       then round(coalesce(sum(o.edited), 0)::numeric / sum(o.drafted), 4)
  end                                 as edit_rate_since,
  r.workspace_id
from public.prompt_rules r
left join public.prompt_versions pv
  on pv.module = r.module
 and pv.workspace_id = r.workspace_id
 and r.activated_at is not null
 and pv.created_at >= r.activated_at
 and (r.retired_at is null or pv.created_at < r.retired_at)
left join public.draft_outcomes o on o.prompt_version_id = pv.id
group by r.id;
