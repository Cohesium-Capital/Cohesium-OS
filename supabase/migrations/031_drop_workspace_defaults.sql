-- 031_drop_workspace_defaults.sql  (tenancy, phase 1 — the finish line)
--
-- 029 gave every workspace_id column a DEFAULT so production kept working while
-- the application learned to pass one. Every write path now does, so the
-- defaults come off.
--
-- This is the migration that makes the isolation real. While a default exists,
-- code that forgets workspace_id writes somewhere plausible; without one, the
-- same omission is a NOT NULL violation at the first INSERT. A loud failure in
-- a code path nobody converted is the entire point — it is recoverable, and a
-- row silently filed under the wrong tenant is not.
--
-- Two globally-unique constraints are also rewritten below. Both predate
-- tenancy and would, on the day a second workspace exists, let one tenant's row
-- block another's.

-- ---------- 1. constraints that must be per workspace ----------

-- learning_signals: 028 rewrote the unique keys it knew about but this one
-- landed in 025 and was missed. The key is what makes signal collection
-- idempotent, so it has to hold per workspace: the same touch_edit id could
-- never collide across tenants, but a signal keyed on a shared ref_table +
-- ref_id (an operator note, a future non-uuid ref) could, and one workspace
-- would then silently swallow the other's correction as a duplicate.
alter table public.learning_signals
  drop constraint if exists learning_signals_ref_table_ref_id_kind_key;
create unique index if not exists learning_signals_ws_ref_key
  on public.learning_signals (workspace_id, ref_table, ref_id, kind);

-- interactions.message_id: an inbound Message-ID is unique to a mailbox, not to
-- the world. Two workspaces polling two mailboxes can legitimately both receive
-- the same message (a reply that copied both firms), and today the second
-- capture would be rejected as a duplicate of the first — a reply silently
-- missing from one tenant's triage queue. The demo seeder makes this concrete:
-- it writes fixed ids like 'demo-tour-reply-1', so the second workspace to run
-- the walkthrough would fail to seed at all.
drop index if exists public.interactions_message_id_key;
create unique index if not exists interactions_ws_message_id_key
  on public.interactions (workspace_id, message_id) where message_id is not null;

-- ---------- 2. drop the bridge ----------

alter table public.organizations   alter column workspace_id drop default;
alter table public.contacts        alter column workspace_id drop default;
alter table public.batches         alter column workspace_id drop default;
alter table public.runs            alter column workspace_id drop default;
alter table public.touches         alter column workspace_id drop default;
alter table public.hooks           alter column workspace_id drop default;
alter table public.sourcing_runs   alter column workspace_id drop default;
alter table public.prompt_versions alter column workspace_id drop default;
alter table public.prompt_rules    alter column workspace_id drop default;
alter table public.learning_signals alter column workspace_id drop default;
alter table public.learning_runs   alter column workspace_id drop default;
alter table public.settings        alter column workspace_id drop default;
alter table public.settings_history alter column workspace_id drop default;
alter table public.interactions    alter column workspace_id drop default;
alter table public.rejected_ingest alter column workspace_id drop default;
alter table public.api_tokens      alter column workspace_id drop default;

-- default_workspace_id() is deliberately KEPT, but it now has exactly one
-- caller: workspace_members-aware code that wants to know which workspace to
-- show a user on first login. It is no longer a column default anywhere, so it
-- can no longer decide where a row lands.
comment on function public.default_workspace_id() is
  'Resolves the caller''s default workspace for UI landing. Not a column default (031) — writes must name their workspace explicitly.';
