-- 049_ilium_advisor_copy.sql
--
-- Ilium's channel-track vocabulary and worked examples (see 048 for the layer
-- itself).
--
-- The channel is the investment advisors and brokers of record attached to a
-- TPA's plans. They are not acquisition targets and never become one — the ask
-- is a two-way referral relationship:
--
--   * an owner they advise who is thinking about succession or liquidity has
--     somewhere real to go, and
--   * when Ilium acquires a firm, that owner walks away liquid and looking for
--     advice, which is an introduction worth having.
--
-- Why a whole copy block rather than word substitution: the msp and customer
-- examples are RESEARCH outreach ("I'm not selling anything, just trying to
-- understand the space"). That sentence is true there and false here, and
-- swapping vocabulary into those examples would produce a fluent message making
-- the wrong ask. lib/drafting/prompt.ts forks the promise line for this track
-- for the same reason.
--
-- Idempotent, and merges rather than replaces: jsonb || touches only these keys
-- and leaves everything 044/047 set — and anything a human has edited in
-- Settings since — exactly where it is.

update public.workspace_profile
   set vocab = coalesce(vocab, '{}'::jsonb) || jsonb_build_object(
         'channelSingular',     'investment advisor',
         'channelPlural',       'investment advisors',
         'channelAbbrev',       'advisor',
         'channelAbbrevPlural', 'advisors'
       ),
       copy = coalesce(copy, '{}'::jsonb) || jsonb_build_object(
         'goldAdvisor',
'Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: {{firmName}} + your TPA relationships

Hi Dana,

Your name came up alongside a couple of the third-party administrators we know
well, and the overlap seemed worth a note.

{{senderIntro}}. We buy TPAs outright, so if an owner you advise ever raises
succession or liquidity, there is a real home for that firm. And when we do
acquire one, that owner walks away liquid and looking for advice.

Worth a short call to see whether this is useful in either direction?

Thanks,
{{senderName}}

LinkedIn —
Hi Alex, {{senderIntro}}. We buy retirement TPAs outright, and it looks like we
work around some of the same firms. If a TPA owner you advise ever raises
succession, there is a home for that business. Worth a quick chat?',

         'personaAnglesAdvisor',
'Persona angle (the relevance hook)
Everyone on this track is an advisor or a principal at an advisory firm. The
persona key is a schema literal, not a description of the person, so read it as
seniority within the practice rather than as a job function:
- owner: a principal or partner of the practice. This is the main audience. The
  angle is what a succession conversation with a TPA owner client looks like,
  and what that owner is looking for on the other side of a sale.
- head_of_it: an advisor at the firm who is not a principal, or whoever runs the
  plan relationships day to day. Same proposition, one level down: what actually
  changes for the plans they oversee when a TPA changes hands, and who to hand
  a succession conversation to.
- other: a neutral version of the owner angle.',

         'perspectiveAdvisor',
         'how an advisor and a buyer of TPAs can be useful to each other',

         'subjectShapesAdvisor',
'"{{firmName}} + your TPA relationships", "succession on the TPA side",
  "{{firmName}} + <company>"'
       ),
       updated_at = now(),
       updated_by = 'migration 049'
 where workspace_id = (
         select id from public.workspaces where name = 'Ilium Holdings' limit 1
       );

-- ---------- verification ----------
-- Expect one Ilium row: investment advisor | TPA | TPA, the last two from
-- 044/047, proving the merge kept them.
select w.name,
       p.vocab->>'channelSingular' as channel_singular,
       p.vocab->>'providerCasual'  as provider_casual,
       p.vocab->>'providerAbbrev'  as provider_abbrev,
       left(p.copy->>'goldAdvisor', 40) as gold_advisor_head,
       p.updated_by
  from public.workspace_profile p
  join public.workspaces w on w.id = p.workspace_id
 order by w.created_at;
