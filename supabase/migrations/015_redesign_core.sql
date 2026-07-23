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
