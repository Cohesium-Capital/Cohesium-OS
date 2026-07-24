-- 017_interactions_nullable_contact.sql
-- A DSN/bounce message that cannot be resolved to a contact must still be
-- stored (it is deduped by message_id; dropping it would retry forever and
-- lose the hygiene signal). Baseline schema made contact_id NOT NULL when
-- interactions only ever recorded known-contact conversations.

alter table public.interactions alter column contact_id drop not null;
