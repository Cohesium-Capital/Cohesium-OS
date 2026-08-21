-- 048_advisor_layer.sql
--
-- A third organization kind: 'advisor'.
--
-- Until now the schema held exactly two kinds — 'msp' (the acquisition target)
-- and 'customer' (that target's clients). Ilium needs a third population that
-- is neither: the investment advisors and brokers of record attached to a TPA's
-- plans. They are not acquisition targets and never become one; they are a
-- REFERRAL CHANNEL into the targets we already hold.
--
-- Two structural facts drove the shape below.
--
-- 1. The relation is many-to-many. An advisory firm sits on plans administered
--    by many TPAs, and a TPA has many advisors across its book.
--    organizations.current_msp_id is a single FK and cannot say that: an
--    advisor on six TPAs' plans would collapse to one, and the shared-plan
--    count that drives tiering would have nowhere to live. Hence a link table.
--
-- 2. The edge is evidence, not just a pointer. Form 5500 reaches an advisor two
--    independent ways — Schedule C (which names the plan's investment adviser,
--    the fee-based population) and Schedule C -> Schedule A (whose
--    INS_BROKER_NAME is the insurance broker of record). They overlap on under
--    10% of firms, so which join produced an edge is a real property of it, and
--    a row that came from both is stronger than one that came from either.
--
-- Deliberately NOT added: a check constraint on advisor firm classification.
-- Classification is an agent's judgement against the firm's site and its Form
-- ADV (Empower Advisory Group, Wilshire and Morningstar all file as INVESTMENT
-- ADVISOR and none of them refers plans), and the vocabulary will move as that
-- work matures. A CHECK here would reject an import for a value the classifier
-- legitimately started emitting, so the column is free text and the contract
-- lives in the runner's references/classify-advisor-firm-type.md.

-- ---------- 1. organizations: admit the third kind ----------

alter table public.organizations
  drop constraint if exists organizations_kind_check;
alter table public.organizations
  add constraint organizations_kind_check
  check (kind in ('msp', 'customer', 'advisor', 'unknown'));

-- The classifier's verdict on the FIRM (not on any one edge): whether this is a
-- fee-based advisory practice that refers, an insurance broker of record, an
-- institutional filer that never refers, or a TPA that files as its own broker.
-- Null until an agent has read the site and the ADV.
alter table public.organizations
  add column if not exists advisor_firm_type text;

comment on column public.organizations.advisor_firm_type is
  'Advisor classification from the runner''s classify-advisor-firm-type contract. Free text by design — see 048.';

-- ---------- 2. the other three places 'msp | customer' is written down ----------
--
-- `kind` on organizations is not the only two-value enumeration of the pipeline.
-- Three more CHECK constraints encode the same assumption, and every one of them
-- is on a write path the advisor track reaches:
--
--   touches.track       stamped by the drafting ingest. THIS is the one that
--                       breaks hardest: a drafted advisor batch would fail its
--                       whole insert on a constraint violation, losing every
--                       draft in the run.
--   hooks.track         stamped by the personalization ingest, and what
--                       hook_outcomes splits its kill-criterion numbers by.
--   sourcing_runs.kind  the yield log written at the end of every import. A
--                       violation here is caught and reported rather than fatal,
--                       so it would fail quietly and corrupt the yield accounting.
--
-- The two _outcomes views group by track rather than filtering on it, so a third
-- value adds rows and changes nothing else.

alter table public.touches drop constraint if exists touches_track_check;
alter table public.touches
  add constraint touches_track_check
  check (track in ('msp', 'customer', 'advisor'));

alter table public.hooks drop constraint if exists hooks_track_check;
alter table public.hooks
  add constraint hooks_track_check
  check (track in ('msp', 'customer', 'advisor'));

alter table public.sourcing_runs drop constraint if exists sourcing_runs_kind_check;
alter table public.sourcing_runs
  add constraint sourcing_runs_kind_check
  check (kind in ('msp', 'customer', 'advisor'));

-- ---------- 3. the advisor -> TPA edge ----------

create table if not exists public.advisor_tpa_links (
    id                uuid primary key default gen_random_uuid(),
    workspace_id      uuid not null references public.workspaces(id) on delete cascade,
    -- Both sides are organizations in the SAME workspace. Nothing in SQL can
    -- express "and both rows' workspace_id equals this one", so import-core
    -- resolves both ids from a workspace-scoped index and the RLS policy below
    -- gates the write.
    advisor_org_id    uuid not null references public.organizations(id) on delete cascade,
    tpa_org_id        uuid not null references public.organizations(id) on delete cascade,
    -- Which Form 5500 join produced this edge. 'both' is the strong case: the
    -- firm is named as the plan's adviser AND as its broker of record.
    join_source       text not null default 'schedule_c'
                        check (join_source in ('schedule_c', 'schedule_a', 'both')),
    -- DISTINCT plans linking the two, deduped across the two joins by the
    -- runner (which is where plan numbers live). Drives shared-plan tiering.
    shared_plan_count integer not null default 0 check (shared_plan_count >= 0),
    -- The filed relation string, verbatim, for the operator to sanity-check.
    relation          text,
    evidence          jsonb not null default '[]',
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    -- A firm that files as its own broker of record would otherwise link to
    -- itself. That case is real (Orenda on 122 of its own plans) and is a
    -- CLASSIFICATION signal, not an edge — import-core holds those rows for
    -- review rather than writing them.
    constraint advisor_tpa_links_not_self check (advisor_org_id <> tpa_org_id)
);

-- One row per pair. Re-running the join updates the counts in place instead of
-- accumulating a duplicate edge per import.
create unique index if not exists advisor_tpa_links_pair_key
  on public.advisor_tpa_links (workspace_id, advisor_org_id, tpa_org_id);

-- "Which advisors reach this TPA?" — the lookup the referral targeting does.
create index if not exists advisor_tpa_links_tpa_idx
  on public.advisor_tpa_links (workspace_id, tpa_org_id);

-- ---------- 4. RLS ----------

alter table public.advisor_tpa_links enable row level security;

drop policy if exists "workspace members" on public.advisor_tpa_links;
create policy "workspace members" on public.advisor_tpa_links
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
