-- 025_prompt_learning.sql
-- The prompt improvement loop: human corrections become prompt rules.
--
-- The shape of the loop:
--   1. COLLECT  every human correction into learning_signals — a draft edited
--      before sending, a hook rejected as generic, a sourced contact graded
--      wrong, a company deleted in review. Each is a human paying attention,
--      which is the scarcest input this system has.
--   2. PROPOSE  an analyzer reads a batch of signals plus the rules already
--      active and proposes short, imperative rules with their evidence.
--   3. GATE     a proposal activates automatically once enough independent
--      signals support it; everything else waits for a human on Settings.
--   4. APPLY    active rules render into the module's prompt template. Because
--      the template is hashed into prompt_versions at run start, a rule change
--      automatically produces a new version — so draft_outcomes already
--      measures whether the rule helped.
--   5. RETIRE   a rule that doesn't reduce the edit rate can be retired, by a
--      human or by a later analyzer pass, and the prompt reverts.
--
-- Why rules live in the database while prompts live in git: the git prompt is
-- the structure (contract, voice, worked examples) and deserves review. What
-- the loop learns is a bounded list of corrections on top of it. Keeping them
-- separate means the loop can never mangle the prompt's shape, and a bad rule
-- is one UPDATE away from gone.

-- ---------- 1. learning_signals ----------
-- One row per human correction, normalized across stages so the analyzer reads
-- one shape. ref_table/ref_id point back at the source row, which is both the
-- provenance and the idempotency key: collection re-runs cannot double-count.

create table if not exists public.learning_signals (
    id           uuid primary key default gen_random_uuid(),
    module       text not null
                   check (module in ('sourcing','enrichment','personalization','drafting')),
    kind         text not null
                   check (kind in ('draft_edit','draft_redraft','hook_reject',
                                   'grade_correction','contact_delete')),
    -- Where in the module this applies: {"track":"customer","channel":"linkedin"}.
    -- Rules inherit this scope so a LinkedIn lesson never rewrites email rules.
    scope        jsonb not null default '{}',
    before_text  text,
    after_text   text,
    -- error_category / reject_category / delete_reason, whichever the source has.
    category     text,
    ref_table    text not null,
    ref_id       uuid not null,
    run_id       uuid references public.runs(id),
    prompt_version_id uuid references public.prompt_versions(id),
    occurred_at  timestamptz not null default now(),
    -- Set when an analyzer pass has consumed this signal. Null = unprocessed.
    processed_at timestamptz,
    created_at   timestamptz not null default now(),
    unique (ref_table, ref_id, kind)
);

create index if not exists learning_signals_unprocessed_idx
  on public.learning_signals (module, occurred_at)
  where processed_at is null;

alter table public.learning_signals enable row level security;
drop policy if exists "members full access" on public.learning_signals;
create policy "members full access" on public.learning_signals
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));

-- ---------- 2. prompt_rules ----------
-- The learned layer. Short imperative statements rendered into the module's
-- prompt. Evidence is kept with the rule so a human reviewing it sees the edits
-- that produced it rather than having to trust the analyzer.

create table if not exists public.prompt_rules (
    id            uuid primary key default gen_random_uuid(),
    module        text not null
                    check (module in ('sourcing','enrichment','personalization','drafting')),
    scope         jsonb not null default '{}',
    rule_text     text not null,
    rationale     text,
    status        text not null default 'proposed'
                    check (status in ('proposed','active','retired','rejected')),
    -- Signals behind the rule: [{signal_id, before, after}] — the receipts.
    evidence      jsonb not null default '[]',
    -- How many DISTINCT human corrections support it. The activation gate.
    support_count int not null default 0,
    confidence    numeric,
    source        text not null default 'analyzer'
                    check (source in ('analyzer','human')),
    -- The prompt version that first carried this rule, for before/after reading
    -- of draft_outcomes.
    activated_prompt_version_id uuid references public.prompt_versions(id),
    created_by    text not null default 'analyzer',
    decided_by    text,
    activated_at  timestamptz,
    retired_at    timestamptz,
    retire_reason text,
    created_at    timestamptz not null default now()
);

create index if not exists prompt_rules_active_idx
  on public.prompt_rules (module) where status = 'active';
create index if not exists prompt_rules_status_idx on public.prompt_rules (status);

alter table public.prompt_rules enable row level security;
drop policy if exists "members full access" on public.prompt_rules;
create policy "members full access" on public.prompt_rules
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));

comment on table public.prompt_rules is
  'Learned prompt guidance derived from human corrections. Active rules render into the module prompt template, which re-hashes into a new prompt_version so outcomes stay attributable.';

-- ---------- 3. learning_runs ----------
-- One row per analyzer pass: what it read, what it proposed, what it cost.
-- An automatic loop that changes prompts has to be auditable after the fact.

create table if not exists public.learning_runs (
    id                 uuid primary key default gen_random_uuid(),
    module             text not null,
    signals_considered int not null default 0,
    proposed           int not null default 0,
    auto_activated     int not null default 0,
    model              text,
    input_tokens       int,
    output_tokens      int,
    error              text,
    trigger            text not null default 'cron'
                         check (trigger in ('cron','manual')),
    created_at         timestamptz not null default now()
);

create index if not exists learning_runs_created_idx on public.learning_runs (created_at);

alter table public.learning_runs enable row level security;
drop policy if exists "members full access" on public.learning_runs;
create policy "members full access" on public.learning_runs
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));

-- ---------- 4. rule performance ----------
-- Did the rule help? A rule rides a prompt version; draft_outcomes already
-- reports per-version reply and edit rates. This view pairs each active
-- drafting rule with the outcomes of the versions that carried it, so the
-- retire decision reads off measured behavior instead of a hunch.

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
  end                                 as edit_rate_since
from public.prompt_rules r
left join public.prompt_versions pv
  on pv.module = r.module
 and r.activated_at is not null
 and pv.created_at >= r.activated_at
 and (r.retired_at is null or pv.created_at < r.retired_at)
left join public.draft_outcomes o on o.prompt_version_id = pv.id
group by r.id;
