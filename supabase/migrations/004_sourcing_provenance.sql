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
