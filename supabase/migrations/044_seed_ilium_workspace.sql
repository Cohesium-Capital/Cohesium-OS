-- 044_seed_ilium_workspace.sql
--
-- Stands up a second tenant, "Ilium Holdings", a tech-enabled roll-up of
-- retirement-plan third-party administrators (TPAs). Ilium researches a
-- different market than Cohesium, so this seeds its own firm identity, market
-- vocabulary (TPA, not MSP), and worked examples (research-style outreach,
-- framed around retirement TPAs and plan sponsors).
--
-- Admins: ripley@cohesiumcap.com (Ripley Carroll, direct membership — already
-- has an auth account) and saagar@iliumholdings.com (Saagar Kulkarni, via a
-- claimable admin invite — becomes admin on first magic-link sign-in).
--
-- Idempotent: safe to re-run. Never clobbers profile copy a human later edits
-- (the on-conflict guard only overwrites this migration's own prior seed).
--
-- NOTE on the sender: sender_name / sender_intro here are the WORKSPACE DEFAULT
-- (the fallback until the per-user-sender code ships). Once that ships, each
-- member signs as themselves; this default covers the interim and any member
-- without a personal identity.

do $$
declare
  ws_id     uuid;
  ripley_id uuid;
begin
  -- Ripley must already exist (verified before writing this migration).
  select id into ripley_id from auth.users where email = 'ripley@cohesiumcap.com';
  if ripley_id is null then
    raise exception 'ripley@cohesiumcap.com has no auth.users row; aborting';
  end if;

  -- 1. The tenant (guarded: name is not unique, so check first).
  select id into ws_id from public.workspaces where name = 'Ilium Holdings' limit 1;
  if ws_id is null then
    insert into public.workspaces (name) values ('Ilium Holdings') returning id into ws_id;
  end if;

  -- 2. Ripley as admin. is_default=false: he already defaults to Cohesium.
  insert into public.workspace_members (workspace_id, user_id, role, is_default)
  values (ws_id, ripley_id, 'admin', false)
  on conflict (workspace_id, user_id) do update set role = 'admin';

  -- 3. Per-module gate settings at the 010/041 defaults.
  insert into public.settings (workspace_id, module, gate_threshold, sample_rate, min_sample_size)
  values
    (ws_id, 'sourcing',        0.20, 1.0, 20),
    (ws_id, 'enrichment',      0.25, 1.0, 20),
    (ws_id, 'personalization', 0.25, 1.0, 20),
    (ws_id, 'drafting',        0.25, 1.0, 20)
  on conflict (workspace_id, module) do nothing;

  -- 4. Firm identity, market vocabulary, and worked examples.
  insert into public.workspace_profile
    (workspace_id, firm_name, sender_name, sender_intro, approach, vocab, copy, updated_by)
  values (
    ws_id,
    'Ilium Holdings',
    'Saagar',
    'I''m a cofounder of Ilium Holdings, where we''re building a modern platform in retirement plan administration',
    'We learn the retirement TPA market by talking with the experienced people who run these firms, about what''s getting harder and what still makes the model work, and it lets us build a network of operators we can be useful to over time.',
    jsonb_build_object(
      'providerSingular',     'third-party administrator',
      'providerPlural',       'third-party administrators',
      'providerAbbrev',       'TPA',
      'providerAbbrevPlural',  'TPAs',
      'providerGeneric',      'TPA',
      'market',               'retirement TPA market',
      'marketShort',          'retirement TPA'
    ),
    jsonb_build_object(
      'approachInline',
'We learn the retirement TPA market by talking with the people who
run these firms, and it lets us build a network of operators we can be useful to
over time.',
      'approachBullet',
'We learn the
  retirement TPA market by talking with the people who run these firms, and it
  lets us build a network of operators we can be useful to over time.',
      'goldCustomer',
'Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: quick question on your 401(k) admin

Hi Trish,

I''ve been digging into how growing companies actually work with their
third-party administrator on the retirement plan — where it takes the compliance
burden off your plate and where it still lands back on you — and figured someone
in your seat would have a clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you''d have a few minutes in the next week or two? I''m not selling
anything, just trying to understand the space.

Thanks,
{{senderName}}

LinkedIn —
Hi Jim, {{senderIntro}} researching how companies work with their TPA on
retirement plan admin, and your read from the sponsor side would be useful. Open
to a quick chat in the next week or two? Not selling anything.',
      'goldMsp',
'Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: your take on the retirement TPA market

Hi Tom,

I''ve been talking with people who''ve built third-party administration firms
about where the market is heading — what''s getting harder, from the compliance
workload to staffing and pricing, and what still makes the model work — and
figured a founder in your seat would have a clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you''d have a few minutes in the next week or two? I''m not selling
anything, just trying to understand the business from the operator''s side.

Thanks,
{{senderName}}

LinkedIn —
Hi Sam, {{senderIntro}} researching the retirement TPA market from the operator''s
side, and your read on where things are heading for TPAs would be useful. Open to
a quick chat? Not selling anything.',
      'personaAnglesCustomer',
'Persona angle (the relevance hook)
- owner: keeping the company''s retirement plan compliant and painless as the
  business grows, without it becoming a distraction.
- head_of_it: where a TPA genuinely takes the compliance work off their plate
  versus where it still lands back on them.
- other: a neutral version of the owner angle.',
      'personaAnglesMsp',
'Persona angle (the relevance hook)
- owner: what it takes to run a healthy TPA today, from the compliance workload
  and staffing to pricing and where the market is heading.
- head_of_it: how administration is changing, with automation and recordkeeper
  dynamics, versus what plan sponsors actually value.
- other: a neutral version of the owner angle.',
      'perspectiveCustomer', 'how companies like theirs work with their TPA',
      'perspectiveMsp',      'what it takes to run a retirement TPA today',
      'subjectShapesCustomer',
'"quick question on your 401(k) admin", "your take on retirement TPAs",
  "{{firmName}} + <company>"',
      'subjectShapesMsp',
'"your take on the retirement TPA market", "the state of retirement TPA",
  "{{firmName}} + <company>"'
    ),
    'migration 044'
  )
  on conflict (workspace_id) do update
    set firm_name    = excluded.firm_name,
        sender_name  = excluded.sender_name,
        sender_intro = excluded.sender_intro,
        approach     = excluded.approach,
        vocab        = excluded.vocab,
        copy         = excluded.copy,
        updated_at   = now(),
        updated_by   = excluded.updated_by
    -- Only overwrite our own prior seed; never a human's later edits.
    where public.workspace_profile.updated_by = 'migration 044';

  -- 5. Saagar as a claimable ADMIN invite (no auth account yet).
  if not exists (
    select 1 from public.workspace_invites
     where workspace_id = ws_id
       and lower(email) = 'saagar@iliumholdings.com'
       and accepted_at is null
  ) then
    insert into public.workspace_invites (workspace_id, email, role, invited_by)
    values (ws_id, 'saagar@iliumholdings.com', 'admin', ripley_id);
  end if;
end $$;

-- ---------- verification ----------
select id, name, created_at from public.workspaces where name = 'Ilium Holdings';

select m.role, m.is_default, u.email
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
 where m.workspace_id = (select id from public.workspaces where name = 'Ilium Holdings' limit 1);

select email, role, (accepted_at is null) as pending
  from public.workspace_invites
 where workspace_id = (select id from public.workspaces where name = 'Ilium Holdings' limit 1);

select module, gate_threshold, sample_rate, min_sample_size
  from public.settings
 where workspace_id = (select id from public.workspaces where name = 'Ilium Holdings' limit 1)
 order by module;

select firm_name, sender_name, vocab->>'providerAbbrev' as abbrev, vocab->>'market' as market,
       jsonb_object_keys(copy) is not null as has_copy
  from public.workspace_profile
 where workspace_id = (select id from public.workspaces where name = 'Ilium Holdings' limit 1)
 limit 1;
