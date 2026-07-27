-- 039_seed_cohesium_copy.sql  (prompts — stop lending Cohesium's market to everyone)
--
-- The drafting prompt's worked examples were Cohesium's: "growing pediatric
-- practices", "the mid-Atlantic", "your take on the MSP market". They were also
-- the built-in DEFAULT, so every workspace created from now on would inherit
-- them.
--
-- That is worse than untidy. The examples are a strong attractor — 12% of
-- Cohesium's own drafts adopted the example's opening frame — and they work
-- precisely BECAUSE they describe Cohesium's real market. Handed to a firm
-- researching staffing agencies, the same pull produces a fluent, well-formed
-- message framed around managed IT. The honesty rules do not catch it, because
-- nothing was fabricated; the message is simply about the wrong thing. It fails
-- silently, in exactly the drafts a new tenant is least equipped to judge.
--
-- So the code default is now market-neutral, and Cohesium's own examples move
-- into their workspace_profile as an override.
--
-- ⚠️ THE TRADE THIS MAKES, STATED PLAINLY: until now Cohesium had no
-- workspace_profile row at all, which is what guaranteed it could never drift
-- from the code (see 032). After this it has one, so future improvements to the
-- DEFAULT examples will no longer reach Cohesium automatically — someone has to
-- edit these. That is the right trade for prose that is genuinely theirs rather
-- than genuinely generic, but it is a trade, not a free win.
--
-- The cohesium_* golden fixtures pin the result: they were captured from the
-- pre-change output and are re-rendered through this override on every test run.

insert into public.workspace_profile (workspace_id, copy, updated_by)
select w.id,
       jsonb_build_object(
         'goldCustomer',
'Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: quick question on your IT setup

Hi Trish,

I''ve been digging into how growing pediatric practices actually work with their
managed IT providers, where it helps and where it just adds overhead, and figured
someone in your seat would have a clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you''d have a few minutes in the next week or two? I''m not selling
anything, just trying to understand the space.

Thanks,
{{senderName}}

LinkedIn —
Hi Jim, {{senderIntro}} researching how companies work with their managed IT
providers, and your read from the practice side would be useful. Open to a quick
chat in the next week or two? Not selling anything.',
         'goldMsp',
'Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: your take on the MSP market

Hi Tom,

I''ve been talking with people who''ve built managed IT businesses in the
mid-Atlantic about where the market is heading, what''s getting harder, what
still makes the model work, and figured a founder in your seat would have a
clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you''d have a few minutes in the next week or two? I''m not selling
anything, just trying to understand the business from the operator''s side.

Thanks,
{{senderName}}

LinkedIn —
Hi Sam, {{senderIntro}} researching the managed IT market from the operator''s
side, and your read on where things are heading for MSPs would be useful. Open
to a quick chat? Not selling anything.',
         'personaAnglesCustomer',
'Persona angle (the relevance hook)
- owner: keeping technology and security dependable as the business grows,
  without IT becoming a distraction.
- head_of_it: where managed services genuinely help versus where they just
  commoditize the work.
- other: a neutral version of the owner angle.',
         'personaAnglesMsp',
'Persona angle (the relevance hook)
- owner: what it takes to build and grow a healthy MSP right now, from pricing
  pressure to talent to the security workload, and where the market is heading.
- head_of_it: how service delivery is changing, with tooling and automation,
  versus what clients actually value and will pay for.
- other: a neutral version of the owner angle.',
         'perspectiveCustomer', 'how companies like theirs work with managed IT',
         'perspectiveMsp',      'what it takes to run a managed IT business today',
         'subjectShapesCustomer',
'"quick question on your IT setup", "your take on managed IT",
  "{{firmName}} + <company>"',
         'subjectShapesMsp',
'"your take on the MSP market", "the state of managed IT",
  "{{firmName}} + <company>"'
       ),
       'migration 039'
  from public.workspaces w
 -- The first workspace only: this is Cohesium's prose, and a workspace created
 -- later must get the neutral default, which is the entire point.
 where w.id = (select id from public.workspaces order by created_at limit 1)
on conflict (workspace_id) do update
  set copy = excluded.copy,
      updated_at = now(),
      updated_by = excluded.updated_by
  -- Never clobber examples someone has already written by hand.
  where public.workspace_profile.copy is null;
