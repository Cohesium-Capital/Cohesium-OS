-- 032_workspace_profile.sql  (tenancy, phase 2 — firm identity + market vocabulary)
--
-- Per-workspace answers to "who is writing this" and "what do we call the market
-- we research". Until now both were hardcoded in the prompt builders: Cohesium's
-- name, Ripley's introduction, and "managed IT service provider / MSP" throughout.
--
-- This table stores OVERRIDES ONLY. Every column is nullable, and a null means
-- "use the built-in default", which is Cohesium's exact current wording (see
-- web/lib/workspace/identity.ts). Cohesium therefore gets no row at all, and its
-- prompts are guaranteed byte-for-byte unchanged — a guarantee the golden
-- fixtures in web/lib/prompts/__fixtures__ enforce on every test run.
--
-- Storing overrides rather than a full copy of the defaults matters: if this
-- table held Cohesium's values and the code defaults later changed, the two
-- would drift silently and the prompts would follow whichever was read last.

create table if not exists public.workspace_profile (
    workspace_id uuid primary key references public.workspaces(id) on delete cascade,

    -- Firm identity. Rendered into every outbound draft.
    firm_name         text,   -- "Cohesium"
    sender_name       text,   -- "Ripley"
    sender_intro      text,   -- "I'm a cofounder of Cohesium, an investment firm"
    approach          text,   -- the one-sentence why-we're-reaching-out

    -- Market vocabulary: {providerSingular, providerPlural, providerAbbrev,
    -- providerAbbrevPlural, providerGeneric, market, marketShort}. Partial
    -- objects are fine; each missing key falls back to its default.
    vocab             jsonb,

    -- Prose blocks too market-specific to word-substitute (gold examples,
    -- persona angles, subject shapes). Keys match DraftCopy in identity.ts, and
    -- values may contain {{tokens}} referring to the identity and vocabulary
    -- above. Partial objects fine, same fallback rule.
    copy              jsonb,

    updated_at        timestamptz not null default now(),
    updated_by        text
);

comment on table public.workspace_profile is
  'Per-workspace prompt identity and vocabulary. Overrides only — null means use the code default (Cohesium''s wording).';

alter table public.workspace_profile enable row level security;

-- Same membership gate as every other workspace-scoped table.
create policy "workspace members" on public.workspace_profile
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Deliberately NO row for Cohesium. An empty table is the correct starting
-- state: every workspace that has not customised anything renders the defaults.
