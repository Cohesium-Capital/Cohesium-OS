-- 020_hooks_unique.sql
-- The stage contract is ONE hook per contact per run (the grades upsert key
-- (contact_id, 'hook', run_id) assumes it). Ingest now dedupes in code; this
-- index is the backstop so no future ingest path can silently reintroduce
-- duplicates — a violating insert errors instead of corrupting the eval set.

create unique index if not exists hooks_contact_run_uniq
  on public.hooks (contact_id, run_id) where run_id is not null;
