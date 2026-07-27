-- 026_learning_strategies.sql
-- Second gear for the learning loop.
--
-- Migration 025 learns incrementally: a pattern in the corrections becomes one
-- more rule appended to the prompt. That is the right response to "the output
-- is mostly good, with a recurring flaw". It is the WRONG response to "half of
-- what this stage produces gets thrown away" — there, the tenth appended rule
-- is not the fix, and stacking rules onto a broken approach mostly makes the
-- prompt longer.
--
-- So the loop now reads each stage's rejection rate and escalates:
--
--   healthy  → propose rules       (incremental, can auto-activate)
--   failing  → propose a STRATEGY  (a replacement approach, never automatic)
--
-- A strategy proposal is an experiment: it captures the stage's rejection rate
-- at activation, so "did the new approach actually work" is answerable from
-- measured behavior a week later rather than from an opinion.

-- ---------- 1. prompt_rules: rules vs strategies ----------

alter table public.prompt_rules
  add column if not exists kind text not null default 'rule'
    check (kind in ('rule','strategy'));

-- The stage's rejection rate when this was activated. The comparison point for
-- "is the experiment working" — without it, a strategy change is unfalsifiable.
alter table public.prompt_rules
  add column if not exists baseline_metric numeric;
alter table public.prompt_rules
  add column if not exists baseline_note text;

comment on column public.prompt_rules.kind is
  'rule = one appended correction, may auto-activate on enough evidence. strategy = a replacement approach proposed when a stage is failing; always requires human approval.';

-- ---------- 2. operator notes are signals too ----------
-- Typed feedback on a prompt is the highest-quality signal available: it is the
-- operator saying what is wrong in their own words, rather than the analyzer
-- inferring it from diffs. It enters the same pipeline as every other signal.

alter table public.learning_signals drop constraint if exists learning_signals_kind_check;
alter table public.learning_signals add constraint learning_signals_kind_check
  check (kind in ('draft_edit','draft_redraft','hook_reject',
                  'grade_correction','contact_delete','operator_note'));

-- ---------- 3. stage_health ----------
-- One rejection rate per stage, over a 30-day window, from whatever "rejected"
-- means for that stage:
--   sourcing         a graded record marked wrong or missing
--   personalization  a researched hook a human rejected
--   drafting         a draft the operator had to edit before it could send
--
-- The drafting rate is deliberately edits-per-draft rather than reply rate:
-- replies are slow, sparse, and confounded by list quality, while an edit is an
-- immediate, unambiguous "this wasn't good enough to send".

create or replace view public.stage_health
with (security_invoker = on) as
with sourcing as (
  select
    'sourcing'::text                                              as module,
    count(*) filter (where g.verdict in ('wrong','missing'))      as rejected,
    count(*)                                                      as judged
  from public.grades g
  where g.module = 'sourcing'
    and g.created_at > now() - interval '30 days'
),
personalization as (
  select
    'personalization'::text                                       as module,
    count(*) filter (where h.status = 'rejected')                 as rejected,
    count(*) filter (where h.status in ('verified','rejected'))   as judged
  from public.hooks h
  where h.verified_at > now() - interval '30 days'
),
drafting as (
  select
    'drafting'::text                                              as module,
    count(distinct e.touch_id)                                    as rejected,
    count(distinct t.id)                                          as judged
  from public.touches t
  left join public.touch_edits e on e.touch_id = t.id
  where t.direction = 'outbound'
    and t.created_at > now() - interval '30 days'
)
select
  module,
  rejected,
  judged,
  case when judged > 0 then round(rejected::numeric / judged, 4) end as reject_rate,
  -- The escalation gate. Both halves matter: a rate needs enough judgments
  -- behind it to mean anything, and three bad drafts out of four is noise at
  -- that volume.
  (judged >= 10 and rejected::numeric / nullif(judged, 0) >= 0.30)   as needs_new_strategy
from (
  select * from sourcing
  union all select * from personalization
  union all select * from drafting
) s;
