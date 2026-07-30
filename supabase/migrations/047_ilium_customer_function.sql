-- 047_ilium_customer_function.sql
--
-- Two vocabulary terms that did not exist when 044 seeded Ilium, because the
-- prompts were not yet asking the profile for them — they said "IT" outright:
--
--   customerFunction  the function inside a PROSPECT that the provider is hired
--                     to carry. Not the provider under another name. It is what
--                     names the second persona: "the person who leads IT" for
--                     Cohesium, "the person who leads HR or benefits" for Ilium.
--                     The persona KEY stays `head_of_it` — a schema CHECK and a
--                     JSON contract literal, like `mspIds`.
--   providerCasual    how a customer casually names the provider they hired.
--                     "IT provider" for Cohesium, "TPA" for Ilium.
--
-- Sourcing, hook research and drafting all read these now, so without this
-- migration Ilium's briefs keep asking for the IT lead at a company that
-- outsources its retirement plan.
--
-- Cohesium needs no row: the code defaults ARE its wording, byte for byte, which
-- the 104 golden fixtures pin.
--
-- Idempotent, and merges rather than replaces: jsonb || overwrites only these
-- two keys and leaves every term 044 set (and anything a human has edited in
-- Settings since) exactly where it is.

update public.workspace_profile
   set vocab = coalesce(vocab, '{}'::jsonb) || jsonb_build_object(
         'customerFunction', 'HR or benefits',
         'providerCasual',   'TPA'
       ),
       updated_at = now(),
       updated_by = 'migration 047'
 where workspace_id = (
         select id from public.workspaces where name = 'Ilium Holdings' limit 1
       );

-- ---------- verification ----------
-- Expect: HR or benefits | TPA | TPA (the last from 044, proving the merge kept it)
select w.name,
       p.vocab->>'customerFunction' as customer_function,
       p.vocab->>'providerCasual'   as provider_casual,
       p.vocab->>'providerAbbrev'   as provider_abbrev,
       p.updated_by
  from public.workspace_profile p
  join public.workspaces w on w.id = p.workspace_id
 order by w.created_at;
