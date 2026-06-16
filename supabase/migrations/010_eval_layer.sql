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
