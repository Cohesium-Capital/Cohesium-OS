-- setup-dev-db.sql
-- One-shot setup for a fresh dev Supabase project.
-- Paste into the Supabase SQL editor (or run via psql) on a NEW project only.
-- Assembled from schema.sql + supabase/migrations/003..018 in order.


-- ============ schema.sql (baseline) ============

-- schema.sql : MSP intelligence engine (Postgres / Supabase)
-- One datastore, both flows (MSP acquisition + customer intelligence).
-- Text + CHECK constraints are used over native enums so the schema stays easy
-- to evolve as the dataset grows.

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- Companies: MSP acquisition targets, their customers, and the MSPs that
-- customers currently use. One table, related to itself.
create table organizations (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    domain          text unique,
    kind            text not null default 'unknown'
                      check (kind in ('msp', 'customer', 'unknown')),
    is_acq_target   boolean not null default false,    -- flag an org as a Cohesium target
    current_msp_id  uuid references organizations(id), -- for a customer: the MSP they use
    hq_city         text,
    hq_state        text,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- People we contact. Persona drives the messaging angle.
create table contacts (
    id                uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references organizations(id) on delete cascade,
    full_name         text,
    persona           text check (persona in ('owner', 'head_of_it', 'other')),
    title             text,
    email             text,
    phone             text,
    linkedin_url      text,
    city              text,
    enrichment_status text not null default 'pending'
                        check (enrichment_status in ('pending','enriched','low_confidence','failed')),
    personalization   text,                            -- the researched hook (stage 2b)
    stage             text not null default 'sourced'
                        check (stage in ('sourced','enriched','queued','contacted',
                                         'responded','in_conversation','intro_path','nurturing','closed')),
    responded         boolean not null default false,  -- the global stop flag
    responded_at      timestamptz,
    source            text,                            -- where we found them
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- Outbound and inbound touches across every channel.
create table touches (
    id            uuid primary key default gen_random_uuid(),
    contact_id    uuid not null references contacts(id) on delete cascade,
    channel       text not null check (channel in ('email','linkedin','letter','call')),
    direction     text not null check (direction in ('outbound','inbound')),
    sequence_step int,
    status        text not null default 'planned'
                    check (status in ('planned','queued','sent','delivered','bounced','replied','failed')),
    scheduled_at  timestamptz,
    sent_at       timestamptz,
    created_at    timestamptz not null default now()
);

-- The raw source of truth: a reply, a thread, a call transcript. Kept forever.
create table interactions (
    id           uuid primary key default gen_random_uuid(),
    contact_id   uuid not null references contacts(id) on delete cascade,
    channel      text not null check (channel in ('email','linkedin','call','other')),
    occurred_at  timestamptz not null default now(),
    raw_content  text not null,
    created_at   timestamptz not null default now()
);

-- Structured insight extracted from one interaction. Versioned and model-stamped
-- so you can re-extract the whole archive when the schema grows.
create table extractions (
    id               uuid primary key default gen_random_uuid(),
    interaction_id   uuid not null references interactions(id) on delete cascade,
    current_msp      text,
    satisfaction     text check (satisfaction in ('positive','neutral','negative','unknown')),
    switching_intent text check (switching_intent in ('none','passive','active','unknown')),
    owner_referenced boolean default false,
    tech_stack       text[] default '{}',
    pain_points      text[] default '{}',
    summary          text,
    extra            jsonb default '{}',
    model_name       text not null,                    -- which brain produced this
    prompt_version   text not null,
    extracted_at     timestamptz not null default now()
);

-- Warm paths: a customer contact who can introduce us to a target MSP. (Goal 1)
create table intro_paths (
    id              uuid primary key default gen_random_uuid(),
    from_contact_id uuid not null references contacts(id) on delete cascade,
    to_msp_id       uuid not null references organizations(id) on delete cascade,
    strength        text check (strength in ('weak','medium','strong','confirmed')),
    status          text not null default 'identified'
                      check (status in ('identified','requested','offered','made','declined')),
    notes           text,
    created_at      timestamptz not null default now()
);

create index on contacts (organization_id);
create index on contacts (stage);
create index on touches (contact_id);
create index on interactions (contact_id);
create index on extractions (interaction_id);
create index on intro_paths (to_msp_id);

-- Example payoff query: rank MSP targets by how happy their customers are.
-- This is the scorecard that re-ranks acquisition targets before you ever
-- send a letter.
--
--   select o.name,
--          count(*) filter (where e.satisfaction = 'negative') as unhappy,
--          count(*) filter (where e.satisfaction = 'positive') as happy
--   from organizations o
--   join contacts c       on c.organization_id = o.current_msp_id
--   join interactions i   on i.contact_id = c.id
--   join extractions e    on e.interaction_id = i.id
--   where o.is_acq_target
--   group by o.name;

-- ============ 003_auth_profiles.sql ============

-- 003_auth_profiles.sql
-- Multi-user auth + role-based RLS. schema.sql is the 001 baseline.
--
-- One profile row per Supabase auth user, carrying a role. RLS is turned on for
-- every data table and gated on that role. v1: 'admin'/'member' get full access,
-- 'partner' gets none (its scoping rules are defined later). The Python worker
-- tier uses the service_role key, which bypasses RLS entirely, so existing
-- scripts (extract.py) are unaffected.

create table if not exists public.profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    email       text,
    full_name   text,
    role        text not null default 'member'
                  check (role in ('admin', 'member', 'partner')),
    created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Current user's role, read without tripping RLS recursion (SECURITY DEFINER
-- bypasses RLS on profiles). Named user_role() to avoid clashing with the
-- built-in current_role.
create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- A user sees their own profile; admins see all.
drop policy if exists "profiles self or admin read" on public.profiles;
create policy "profiles self or admin read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.user_role() = 'admin');

-- Admins can update any profile (e.g. grant a role); users may update their own
-- non-role fields. Role changes are intended to be admin-only; enforce in app.
drop policy if exists "profiles admin write" on public.profiles;
create policy "profiles admin write" on public.profiles
  for all to authenticated
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- Auto-create a profile when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Data tables: enable RLS and grant full access to admin/member only.
do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations', 'contacts', 'touches',
    'interactions', 'extractions', 'intro_paths'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "members full access" on public.%I;', t);
    execute format(
      'create policy "members full access" on public.%I for all to authenticated '
      || 'using (public.user_role() in (''admin'', ''member'')) '
      || 'with check (public.user_role() in (''admin'', ''member''));',
      t
    );
  end loop;
end $$;

-- ============ 004_sourcing_provenance.sql ============

-- 004_sourcing_provenance.sql
-- Sourcing confidence + provenance. A low-confidence or not-yet-reviewed row is
-- "flagged", and that flag rides through every view that shows the row.
--   flagged  ==  confidence = 'low' OR reviewed = false
-- 'reviewed' is set true when a human has cleared/accepted the row in the grid.
-- source_url is the research provenance (distinct from contacts.source, which is
-- a free-text "where we found them" descriptor that already exists).

alter table public.organizations
  add column if not exists confidence text check (confidence in ('high', 'medium', 'low')),
  add column if not exists source_url text,
  add column if not exists reviewed   boolean not null default false;

alter table public.contacts
  add column if not exists confidence text check (confidence in ('high', 'medium', 'low')),
  add column if not exists source_url text,
  add column if not exists reviewed   boolean not null default false;

-- ============ 005_sourcing_runs.sql ============

-- 005_sourcing_runs.sql
-- A log of every import, so we can measure sourcing yield over time. A "targeted"
-- run (target_msp_id set) records how many NEW customers it added for that MSP
-- (new_for_target). The MSP dashboard reads this to auto-judge when an MSP is
-- tapped out: a single targeted run that adds 0 new customers => exhausted.

create table if not exists public.sourcing_runs (
    id                 uuid primary key default gen_random_uuid(),
    kind               text not null check (kind in ('msp', 'customer')),
    target_msp_id      uuid references public.organizations(id) on delete set null,
    requested          int,
    inserted_orgs      int not null default 0,
    inserted_contacts  int not null default 0,
    skipped_duplicates int not null default 0,
    new_for_target     int,            -- new customers attributed to target_msp_id; null when untargeted
    created_by         uuid references auth.users(id),
    created_at         timestamptz not null default now()
);

create index if not exists sourcing_runs_target_idx on public.sourcing_runs (target_msp_id);
create index if not exists sourcing_runs_created_idx on public.sourcing_runs (created_at);

alter table public.sourcing_runs enable row level security;

drop policy if exists "members full access" on public.sourcing_runs;
create policy "members full access" on public.sourcing_runs
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));

-- ============ 006_msp_stats_view.sql ============

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

-- ============ 007_touch_drafts.sql ============

-- 007_touch_drafts.sql
-- A planned outbound touch carries its drafted copy. (Supersedes the files4
-- draft 002_touch_message_body.sql, which was never applied.) 'approved' defaults
-- true so the send-selection grid sends to all unless you uncheck a row.

alter table public.touches add column if not exists subject  text;  -- email only
alter table public.touches add column if not exists body     text;
alter table public.touches add column if not exists approved boolean not null default true;

create index if not exists touches_status_idx on public.touches (status);

-- ============ 008_touch_send.sql ============

-- 008_touch_send.sql
-- Send-layer tracking on touches: which provider sent it and the provider's id
-- for that lead/message, so reply/status webhooks can match back to the touch.

alter table public.touches add column if not exists provider     text
  check (provider in ('smartlead', 'heyreach'));
alter table public.touches add column if not exists provider_ref text;

create index if not exists touches_provider_ref_idx on public.touches (provider_ref);

-- ============ 009_provider_smtp.sql ============

-- 009_provider_smtp.sql
-- Allow 'smtp' as a touch provider (self-hosted email via cohesium.co).

alter table public.touches drop constraint if exists touches_provider_check;
alter table public.touches add constraint touches_provider_check
  check (provider in ('smartlead', 'heyreach', 'smtp'));

-- ============ 010_eval_layer.sql ============

-- 010_eval_layer.sql
-- Folds Gradebook's eval/quality discipline into Cohesium-OS, additively.
--
-- New eval tables (batches, prompt_versions, runs, grades, settings,
-- rejected_ingest) sit alongside the existing spine (organizations / contacts /
-- touches) and the existing sourcing_runs yield-log (which the msp_stats view
-- still reads, untouched). The generalized `runs` table here tracks the
-- execution LIFECYCLE of any module run (sourcing/enrichment/personalization/
-- drafting) and its provenance — distinct from sourcing_runs, which counts yield.
--
-- A "batch" groups the records one run produced. A batch advances (to enrich /
-- draft / send) only once a graded sample clears the module's error-rate
-- threshold (the gate). Records without evidence are rejected at ingest and
-- logged to rejected_ingest, never made reviewable.
--
-- Convention (matches schema.sql): text + CHECK over native enums; RLS on every
-- table, gated on public.user_role() in ('admin','member'); the service_role key
-- bypasses RLS for headless scripts/webhooks.

-- ---------- batches ----------

create table if not exists public.batches (
    id          uuid primary key default gen_random_uuid(),
    module      text not null
                  check (module in ('sourcing','enrichment','personalization','drafting')),
    label       text not null,
    gate_status text not null default 'open'
                  check (gate_status in ('open','passed','failed')),
    created_at  timestamptz not null default now()
);

-- ---------- prompt_versions ----------

create table if not exists public.prompt_versions (
    id          uuid primary key default gen_random_uuid(),
    module      text not null
                  check (module in ('sourcing','enrichment','personalization','drafting')),
    version     int not null,
    prompt      text not null,
    notes       text,
    active      boolean not null default false,
    created_by  text not null default 'system',
    created_at  timestamptz not null default now(),
    unique (module, version)
);

-- ---------- runs (generalized execution lifecycle) ----------
-- executor records the AI execution path: 'copy_paste' (operator pastes into
-- Claude.ai — the default, free) or 'runner' (automated Agent SDK / API, P5).
-- provider_label stamps the resolved path/model for runner runs.

create table if not exists public.runs (
    id                 uuid primary key default gen_random_uuid(),
    module             text not null
                         check (module in ('sourcing','enrichment','personalization','drafting')),
    prompt_version_id  uuid references public.prompt_versions(id),
    batch_id           uuid references public.batches(id),
    executor           text not null default 'copy_paste'
                         check (executor in ('copy_paste','runner')),
    provider_label     text,
    config             jsonb not null default '{}',
    status             text not null default 'queued'
                         check (status in ('queued','awaiting_input','running','ingesting',
                                           'review_ready','failed')),
    raw_io_path        text,
    raw_io             jsonb,
    cost_usd           numeric,
    error              text,
    started_at         timestamptz,
    finished_at        timestamptz,
    created_by         uuid references auth.users(id),
    created_at         timestamptz not null default now()
);

create index if not exists runs_module_status_idx on public.runs (module, status);
create index if not exists runs_batch_idx on public.runs (batch_id);

-- ---------- grades (one verdict per contact-field-run) ----------

create table if not exists public.grades (
    id              uuid primary key default gen_random_uuid(),
    contact_id      uuid not null references public.contacts(id) on delete cascade,
    module          text not null
                      check (module in ('sourcing','enrichment','personalization','drafting')),
    field           text not null,    -- e.g. company|name|role|email|linkedin|personalization
    verdict         text not null check (verdict in ('correct','wrong','missing')),
    correction      text,
    previous_value  text,             -- value before correction — eval-set input
    error_category  text check (error_category in ('stale_data','wrong_person','wrong_company',
                                                   'hallucinated','bad_evidence','formatting',
                                                   'misaligned_note','other')),
    grader          text not null,
    seconds_spent   int,
    run_id          uuid references public.runs(id),
    created_at      timestamptz not null default now(),
    unique (contact_id, field, run_id)   -- re-grading replaces
);

create index if not exists grades_module_idx on public.grades (module);
create index if not exists grades_contact_idx on public.grades (contact_id);

-- ---------- settings (per-module gate config) ----------

create table if not exists public.settings (
    module          text primary key
                      check (module in ('sourcing','enrichment','personalization','drafting')),
    gate_threshold  numeric not null,           -- record-level error-rate ceiling
    sample_rate     numeric not null default 1.0,
    min_sample_size int not null default 20,
    auto_escalate   boolean not null default true,
    escalated_at    timestamptz,
    run_after_gate  boolean not null default true
);

-- ---------- rejected_ingest (evidence-less output, logged) ----------

create table if not exists public.rejected_ingest (
    id          uuid primary key default gen_random_uuid(),
    run_id      uuid references public.runs(id),
    payload     jsonb not null,
    reason      text not null,
    created_at  timestamptz not null default now()
);

-- ---------- new columns on the spine ----------
-- contacts.review_status is the richer grading status (alongside the existing
-- boolean `reviewed`); sampled drives deterministic grading; evidence holds the
-- source citations behind the row.

alter table public.contacts
  add column if not exists batch_id      uuid references public.batches(id),
  add column if not exists sampled       boolean not null default true,
  add column if not exists review_status text not null default 'pending_review'
        check (review_status in ('pending_review','approved','rejected','corrected','skipped_sampling')),
  add column if not exists evidence      jsonb not null default '[]';

alter table public.organizations
  add column if not exists evidence jsonb not null default '[]';

create index if not exists contacts_batch_idx on public.contacts (batch_id);
create index if not exists contacts_review_status_idx on public.contacts (review_status);

-- ---------- seed: per-module gate settings ----------

insert into public.settings (module, gate_threshold, sample_rate, min_sample_size) values
  ('sourcing',        0.20, 1.0, 20),
  ('enrichment',      0.25, 1.0, 20),
  ('personalization', 0.25, 1.0, 20),
  ('drafting',        0.25, 1.0, 20)
on conflict (module) do nothing;

-- ---------- seed: prompt_versions v1 ----------
-- The versioned instruction text (CONTRACT + RULES + METHODS for sourcing;
-- HEADER + RULES for drafting). Runtime config (region, count, MSP list,
-- contact lines) is substituted by lib/<module>/prompts.ts at render time.
-- Dollar-quoted to avoid escaping. Kept in sync with the code prompt builders.

insert into public.prompt_versions (module, version, prompt, active, notes)
select 'sourcing', 1, $sourcing_v1$Return ONLY a single JSON object. No markdown, no code fences, no commentary
before or after it. The object must match this shape exactly:

{
  "organizations": [
    {
      "name": string,
      "domain": string | null,
      "hq_city": string | null,
      "hq_state": string | null,
      "current_msp_name": string | null,
      "source_url": string | null,
      "confidence": "high" | "medium" | "low",
      "contacts": [
        {
          "full_name": string | null,
          "persona": "owner" | "head_of_it" | "other",
          "title": string | null,
          "linkedin_url": string | null,
          "source_url": string | null,
          "confidence": "high" | "medium" | "low"
        }
      ]
    }
  ]
}

Rules:
- Use web search to ground every row. Do NOT invent a company, person, domain,
  or MSP relationship. An honest omission is always better than a confident guess.
- For anything not verifiable, use null and set "confidence" to "low".
- "confidence" reflects how sure you are that the entity is real AND that the
  stated relationship is true. Reserve "high" for facts backed by a citable source.
- Always include a "source_url" when you can. Put a real URL or null.
- A bare host like "acme.com" for domain — no https://, no path.
- Prefer a real "full_name" for each contact; only leave it null at low confidence.
- Find each contact's LinkedIn profile URL; use null only if you genuinely cannot.
- Output the JSON object and nothing else.

Where to look (highest-yield first): the MSP's own case studies/testimonials/
client-logo pages and indexed PDFs; verified review sites (Clutch, G2, UpCity,
TechBehemoths, GoodFirms, FeaturedCustomers, Google reviews); web-wide co-mentions
via search operators; LinkedIn win/onboarding posts and press releases. A
co-mention does not prove a client relationship — verify intent and set confidence
to match the strength of the evidence. EVERY row must carry a source_url; a row
without evidence is rejected at ingest.$sourcing_v1$, true,
  'Seeded from lib/sourcing/prompts.ts (CONTRACT + RULES + METHODS).'
where not exists (
  select 1 from public.prompt_versions where module = 'sourcing' and version = 1
);

insert into public.prompt_versions (module, version, prompt, active, notes)
select 'drafting', 1, $drafting_v1$You draft warm cold-outreach for the sender at Cohesium. Each recipient runs or
leads IT at a company that uses a managed IT service provider (an MSP). The goal
is an honest ask for a short conversation about how companies like theirs work
with their IT provider. The sender is genuinely researching the managed IT market
and is not selling anything.

For EACH contact, draft a message for EACH channel on that contact's line. Return
ONLY a single JSON object:
{ "drafts": [ { "contact_id": string, "channel": "email" | "linkedin", "subject": string | null, "body": string } ] }

Structure (model on warm investor outreach that works):
- Open casually and acknowledge it is a cold email.
- Say who you are in one line.
- Give the approach briefly: we learn by talking to experienced operators about
  what matters and what pain points still need solving, and build a network of
  sharp people we can be useful to over time.
- Personalize with ONE true, verifiable detail, strongly preferring the LAST 12
  MONTHS (a recent talk, panel, podcast, conference appearance, announcement, or
  post). Then credit their perspective on how companies like theirs work with
  managed IT.
- VERIFY every specific claim with web search before using it. If you cannot
  verify a recent specific detail, open with an honest observation instead.
- Close with a soft ask and say plainly you are not selling anything.

Persona angle: owner = keeping tech/security dependable as the business grows;
head_of_it = where managed services help vs commoditize; other = neutral owner angle.

Length: email under ~130 words, two or three short paragraphs, signed off; subject
short and specific. linkedin: no subject, 300 chars max, one line of relevance and
one light ask.

Voice: direct, warm, conversational, humble. No em-dashes, semicolons, bullets, or
corporate filler. Never invent a detail, event, connection, or claim. Refer to the
firm only as "Cohesium".$drafting_v1$, true,
  'Seeded from lib/drafting/prompt.ts (HEADER + RULES).'
where not exists (
  select 1 from public.prompt_versions where module = 'drafting' and version = 1
);

-- ---------- backfill: existing contacts into a legacy, already-passed batch ----------
-- Current live data flows unchanged: it is treated as an approved sourcing batch
-- that has already cleared the gate, and is exempt from sampling.

insert into public.batches (module, label, gate_status)
select 'sourcing', 'legacy', 'passed'
where not exists (select 1 from public.batches where label = 'legacy');

update public.contacts
set batch_id = (select id from public.batches where label = 'legacy' limit 1),
    review_status = 'approved',
    sampled = false
where batch_id is null;

-- ---------- RLS: members full access on the new eval tables ----------

do $$
declare
  t text;
begin
  foreach t in array array[
    'batches', 'prompt_versions', 'runs', 'grades', 'settings', 'rejected_ingest'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "members full access" on public.%I;', t);
    execute format(
      'create policy "members full access" on public.%I for all to authenticated '
      || 'using (public.user_role() in (''admin'', ''member'')) '
      || 'with check (public.user_role() in (''admin'', ''member''));',
      t
    );
  end loop;
end $$;

-- ============ 011_sample_rate.sql ============

-- 011_sample_rate.sql
-- Practical grading load: sample ~20% of each batch (deterministic FNV-1a) rather
-- than grading every record. min_sample_size stays 20, so small batches are still
-- graded in full. Once the sampled subset clears the error threshold, the whole
-- batch — sampled and unsampled riders — advances. Adjustable later in Settings.

update public.settings set sample_rate = 0.2
where module in ('sourcing', 'enrichment', 'personalization', 'drafting');

-- ============ 012_batch_stats_view.sql ============

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

-- ============ 013_touches_queued_status.sql ============

-- The email drip queues approved touches as 'queued' (lib/send/send.ts) and the
-- cron worker (/api/cron/email) sends from that state. The original
-- touches_status_check predated the drip and omitted 'queued', so queuing emails
-- failed with: new row for relation "touches" violates check constraint
-- "touches_status_check". Add 'queued' to the allowed set.

alter table public.touches drop constraint if exists touches_status_check;

alter table public.touches
  add constraint touches_status_check
  check (status in ('planned','queued','sent','delivered','bounced','replied','failed'));

-- ============================================================
-- 014_touch_provenance.sql
-- ============================================================

-- 014_touch_provenance.sql
-- Phase 1 of the learning loop: make every outbound message traceable to the
-- run and prompt version that produced it, log human edits as quality signals,
-- and stamp outcome timestamps — so reply rates can be computed per prompt
-- version, channel, and persona.
--
-- Three pieces:
--   1. Provenance columns on touches (run_id, prompt_version_id).
--   2. touch_edits: an audit log of human edits to draft copy. An edit is an
--      implicit "the AI draft wasn't good enough" signal — the previous/new
--      pair is eval-set material, same shape as grades corrections.
--   3. Outcome timestamps (replied_at, bounced_at) + the draft_outcomes view
--      aggregating the funnel per prompt version.

-- ---------- 1. provenance on touches ----------

alter table public.touches
  add column if not exists run_id            uuid references public.runs(id),
  add column if not exists prompt_version_id uuid references public.prompt_versions(id);

create index if not exists touches_run_idx on public.touches (run_id);
create index if not exists touches_prompt_version_idx on public.touches (prompt_version_id);

-- ---------- 2. touch_edits (human edits = implicit quality grades) ----------

create table if not exists public.touch_edits (
    id             uuid primary key default gen_random_uuid(),
    touch_id       uuid not null references public.touches(id) on delete cascade,
    field          text not null check (field in ('subject', 'body')),
    previous_value text,
    new_value      text,
    editor         text not null,              -- email or 'system'
    created_at     timestamptz not null default now()
);

create index if not exists touch_edits_touch_idx on public.touch_edits (touch_id);

alter table public.touch_edits enable row level security;

drop policy if exists "members full access" on public.touch_edits;
create policy "members full access" on public.touch_edits
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));

-- ---------- 3. outcome timestamps ----------
-- status already tracks replied/bounced, but transitions overwrite each other
-- and carry no time. Timestamps make time-to-reply and rate windows computable.

alter table public.touches
  add column if not exists replied_at timestamptz,
  add column if not exists bounced_at timestamptz;

-- ---------- 4. draft_outcomes view ----------
-- The scoreboard for the learning loop: per prompt version (plus a null row for
-- legacy/unattributed touches), how drafts moved through the funnel.
-- security_invoker = on so RLS applies to the querying user.

create or replace view public.draft_outcomes
with (security_invoker = on) as
select
  t.prompt_version_id,
  pv.module,
  pv.version,
  t.channel,
  count(*)                                                    as drafted,
  count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                      or t.sent_at is not null)               as sent,
  count(*) filter (where t.status = 'replied')                as replied,
  count(*) filter (where t.status = 'bounced')                as bounced,
  count(distinct e.touch_id)                                  as edited,
  round(
    count(*) filter (where t.status = 'replied')::numeric
      / nullif(count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                                   or t.sent_at is not null), 0),
    4)                                                        as reply_rate,
  min(t.sent_at)                                              as first_sent_at,
  max(t.sent_at)                                              as last_sent_at
from public.touches t
left join public.prompt_versions pv on pv.id = t.prompt_version_id
left join public.touch_edits e on e.touch_id = t.id
where t.direction = 'outbound'
group by t.prompt_version_id, pv.module, pv.version, t.channel;


-- ============================================================
-- 015_redesign_core.sql
-- ============================================================

-- 015_redesign_core.sql
-- Redesign demo cut, phase 1 (additive only — see docs/FRESH-EYES-REDESIGN.md).
-- Adds the durable-judgment and lineage machinery the redesign needs BEFORE the
-- first real data run, so real data lands with full provenance:
--   1. suppressions        — opt-out / bounce / manual do-not-contact (honesty)
--   2. gate_decisions      — append-only snapshot of every gate flip
--   3. settings_history    — append-only log of gate-setting changes
--   4. enrichment_events   — Clay push/write-back provenance (provider, payload)
--   5. contacts            — run_id lineage, soft-delete, vet attribution
--   6. touches             — audience track, explicit approval, soft-delete;
--                            approved now defaults FALSE (reviewed ≠ default)
--   7. interactions        — touch linkage + verbatim reply capture + triage
--   8. runs                — rendered prompt snapshot + template hash + report
--   9. prompt_versions     — mechanical versioning (hash) + revision lineage
-- Convention (matches 010): text + CHECK over native enums; RLS on every new
-- table via public.user_role() in ('admin','member'); service_role bypasses.

-- ---------- 1. suppressions ----------
-- A contact with any non-revoked suppression must never be sent to, by any
-- channel. 'pending' rows come from the conservative auto-matcher (e.g. a reply
-- containing "unsubscribe") and BLOCK sends until a human confirms or revokes.

create table if not exists public.suppressions (
    id          uuid primary key default gen_random_uuid(),
    contact_id  uuid not null references public.contacts(id) on delete cascade,
    reason      text not null check (reason in ('opt_out','hard_bounce','manual','auto_pending')),
    status      text not null default 'active' check (status in ('active','pending','revoked')),
    source      text,             -- e.g. 'reply:<interaction_id>', 'operator'
    note        text,
    created_by  text not null default 'system',
    created_at  timestamptz not null default now()
);

create index if not exists suppressions_contact_idx on public.suppressions (contact_id) where status <> 'revoked';

-- ---------- 2. gate_decisions (append-only) ----------
-- One row per gate STATUS CHANGE, snapshotting the numbers that produced it.
-- batches.gate_status remains the current-state pointer; this is its history.

create table if not exists public.gate_decisions (
    id              uuid primary key default gen_random_uuid(),
    batch_id        uuid not null references public.batches(id) on delete cascade,
    status          text not null check (status in ('open','passed','failed')),
    graded_count    int not null,
    error_count     int not null,
    sample_size     int not null,
    threshold       numeric not null,
    sample_rate     numeric,
    min_sample_size int,
    decided_at      timestamptz not null default now()
);

create index if not exists gate_decisions_batch_idx on public.gate_decisions (batch_id);

-- ---------- 3. settings_history (append-only) ----------

create table if not exists public.settings_history (
    id          uuid primary key default gen_random_uuid(),
    module      text not null,
    changes     jsonb not null,   -- {field: {old, new}, ...}
    actor       text not null default 'system',
    reason      text,
    created_at  timestamptz not null default now()
);

-- ---------- 4. enrichment_events ----------
-- Provenance for the Clay round-trip: which contacts were pushed when, and what
-- each write-back actually carried (provider verification status included when
-- Clay sends one). 'pending' on contacts finally becomes disambiguable.

create table if not exists public.enrichment_events (
    id          uuid primary key default gen_random_uuid(),
    contact_id  uuid not null references public.contacts(id) on delete cascade,
    provider    text not null default 'clay',
    event       text not null check (event in ('pushed','writeback')),
    payload     jsonb not null default '{}',
    created_at  timestamptz not null default now()
);

create index if not exists enrichment_events_contact_idx on public.enrichment_events (contact_id);

-- ---------- 5. contacts: lineage, soft-delete, vet attribution ----------

alter table public.contacts
  add column if not exists run_id        uuid references public.runs(id),
  add column if not exists deleted_at    timestamptz,
  add column if not exists delete_reason text,
  add column if not exists reviewed_by   text,
  add column if not exists reviewed_at   timestamptz;

create index if not exists contacts_run_idx on public.contacts (run_id);
create index if not exists contacts_deleted_idx on public.contacts (deleted_at) where deleted_at is not null;

-- ---------- 6. touches: track, explicit approval, soft-delete ----------
-- approved flips to default FALSE: an unreviewed draft must not be sendable by
-- default. Existing rows keep their current value (no retro-update).

alter table public.touches
  add column if not exists track         text check (track in ('msp','customer')),
  add column if not exists approved_by   text,
  add column if not exists approved_at   timestamptz,
  add column if not exists deleted_at    timestamptz,
  add column if not exists delete_reason text,
  add column if not exists last_error    text;   -- durable send-failure detail (status 'failed')

alter table public.touches alter column approved set default false;

create index if not exists touches_track_idx on public.touches (track);

-- ---------- 7. interactions: reply capture + triage ----------
-- The verbatim-reply resurrection. touch_id is matched via In-Reply-To against
-- the outbound Message-ID stored in touches.provider_ref; message_id dedupes
-- repeated IMAP polls. disposition is the human triage verdict.

alter table public.interactions
  add column if not exists touch_id    uuid references public.touches(id) on delete set null,
  add column if not exists message_id  text,
  add column if not exists headers     jsonb,
  add column if not exists source      text check (source in ('imap','heyreach','smartlead','manual')),
  add column if not exists disposition text check (disposition in
        ('positive','neutral','not_now','opt_out','ooo_auto','wrong_person','bounce')),
  add column if not exists triaged_by  text,
  add column if not exists triaged_at  timestamptz;

create unique index if not exists interactions_message_id_key
  on public.interactions (message_id) where message_id is not null;
create index if not exists interactions_touch_idx on public.interactions (touch_id);
create index if not exists interactions_untriaged_idx on public.interactions (occurred_at)
  where disposition is null;

-- ---------- 8. runs: honest prompt + ingest capture ----------

alter table public.runs
  add column if not exists rendered_prompt  text,
  add column if not exists template_hash    text,
  add column if not exists ingest_report    jsonb,
  add column if not exists require_evidence boolean;

create index if not exists runs_template_hash_idx on public.runs (template_hash);

-- ---------- 9. prompt_versions: mechanical versioning + lineage ----------
-- template_hash makes version registration automatic: a run whose template
-- hash has no prompt_versions row auto-creates the next version for its
-- module. motivated_by links a revision to the gate decision that prompted it.

alter table public.prompt_versions
  add column if not exists template_hash text,
  add column if not exists motivated_by  uuid references public.gate_decisions(id),
  add column if not exists retired_at    timestamptz;

create unique index if not exists prompt_versions_module_hash_key
  on public.prompt_versions (module, template_hash) where template_hash is not null;

-- ---------- RLS on new tables ----------

do $$
declare
  t text;
begin
  foreach t in array array[
    'suppressions', 'gate_decisions', 'settings_history', 'enrichment_events'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "members full access" on public.%I;', t);
    execute format(
      'create policy "members full access" on public.%I for all to authenticated '
      || 'using (public.user_role() in (''admin'', ''member'')) '
      || 'with check (public.user_role() in (''admin'', ''member''));',
      t
    );
  end loop;
end $$;


-- ============================================================
-- 016_draft_outcomes_v2.sql
-- ============================================================

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


-- ============================================================
-- 017_interactions_nullable_contact.sql
-- ============================================================

-- 017_interactions_nullable_contact.sql
-- A DSN/bounce message that cannot be resolved to a contact must still be
-- stored (it is deduped by message_id; dropping it would retry forever and
-- lose the hygiene signal). Baseline schema made contact_id NOT NULL when
-- interactions only ever recorded known-contact conversations.

alter table public.interactions alter column contact_id drop not null;


-- ============================================================
-- 018_email_lowercase.sql
-- ============================================================

-- 018_email_lowercase.sql
-- Reply capture matches sender addresses (lowercased by the IMAP poll) against
-- contacts.email. Clay write-backs store emails verbatim, so a mixed-case
-- stored address silently fails the match — the reply (or unsubscribe) is
-- dropped and the drip keeps sending. Normalize: lowercase at rest; the
-- write-back route lowercases on the way in from now on.

update public.contacts
set email = lower(email)
where email is not null and email <> lower(email);
