// Who a workspace is, and what it calls the market it sells into.
//
// Every prompt in the system currently hardcodes Cohesium's identity ("a
// cofounder of Cohesium") and one market's vocabulary ("managed IT service
// provider", "MSP"). A second firm researching a different market needs both to
// change, but nothing about Cohesium's output may move while that becomes
// possible — the prompts are the product, and prompt_versions is what error
// rates are compared across.
//
// So the defaults below are exactly the strings that were previously inline,
// and the golden fixtures in lib/prompts/__fixtures__ prove it.

export type WorkspaceIdentity = {
  /** How the firm is named in prompts. Prompts refer to it ONLY by this. */
  firmName: string;
  /** The sender's first name — signs messages, appears in the framing. */
  senderName: string;
  /** One honest line of "who I am", used verbatim in drafts. */
  senderIntro: string;
  /**
   * The approach, as one unwrapped sentence. Canonical: the wrapped forms in
   * DraftCopy are renderings of THIS, and the Settings UI edits this.
   */
  approach: string;
  /** The approach, long form: the drafting rule that explains what to say. */
  approachDetailed: string;
};

export type WorkspaceVocab = {
  /** "managed IT service provider" — the firm's target company type. */
  providerSingular: string;
  /** "managed IT service providers" */
  providerPlural: string;
  /** "MSP" — the short form the market itself uses. */
  providerAbbrev: string;
  /** "MSPs" — stored, not derived: not every plural takes an s. */
  providerAbbrevPlural: string;
  /** "managed IT provider" — how a customer would refer to theirs. */
  providerGeneric: string;
  /** "managed IT market" — the market being researched. */
  market: string;
  /** "managed IT" — the bare category, for subject lines. */
  marketShort: string;
  /**
   * "IT" — the FUNCTION inside a prospect that the provider is hired to carry.
   *
   * This is the one the prompts kept getting wrong, because it is not the
   * provider under another name. `head_of_it` is the second persona at every
   * customer we research, and describing them needs the function ("the person
   * who leads IT"), not the vendor. A tenant whose providers administer
   * retirement plans sets "HR or benefits" here; the persona KEY stays
   * `head_of_it`, since it is a schema CHECK and a JSON contract literal.
   */
  customerFunction: string;
  /**
   * "referral partner" — the CHANNEL population: firms that sit alongside our
   * targets and can refer their owners to us.
   *
   * Not a target and never becomes one. Ilium's channel is the investment
   * advisors and brokers of record on a TPA's plans; a tenant with no channel
   * layer simply never runs the advisor mode and these go unused.
   */
  channelSingular: string;
  /** "referral partners" */
  channelPlural: string;
  /** "partner" — the short form used inside a sentence. */
  channelAbbrev: string;
  /** "partners" — stored, not derived. */
  channelAbbrevPlural: string;
  /**
   * "IT provider" — how a customer casually names the provider they hired.
   *
   * Distinct from providerGeneric ("managed IT provider") only because the
   * prompts already say the shorter thing, and moving Cohesium's bytes to reuse
   * an existing key would fork prompt_versions for no behavioural gain. A TPA
   * tenant sets "TPA" and both read correctly.
   */
  providerCasual: string;
};

/**
 * Prose blocks that are market-specific rather than word-substitutable.
 *
 * The gold examples talk about "growing pediatric practices" and the
 * mid-Atlantic; the persona angles talk about security workload and pricing
 * pressure. Swapping a vocabulary term into those would produce fluent
 * nonsense for a firm researching a different market ("how growing pediatric
 * practices work with their staffing agencies"), so a workspace replaces the
 * whole block instead of having words substituted inside it.
 *
 * Each may contain {{tokens}} — see renderCopy — so an override can still refer
 * to the sender and the vocabulary without repeating them literally.
 */
export type DraftCopy = {
  /**
   * The approach sentence, wrapped for the gold examples, and again for the
   * email-structure bullet where it sits indented inside a numbered item.
   *
   * Two strings for one sentence because the original prompt wrapped it
   * differently in each place, and a prompt's line breaks are part of its
   * hash — re-wrapping would fork prompt_versions and reset the error-rate
   * comparison for no behavioural gain. Edit these together with `approach`.
   */
  approachInline: string;
  approachBullet: string;
  goldCustomer: string;
  goldMsp: string;
  personaAnglesCustomer: string;
  personaAnglesMsp: string;
  perspectiveCustomer: string;
  perspectiveMsp: string;
  subjectShapesCustomer: string;
  subjectShapesMsp: string;
  /**
   * The channel track (048). A separate block rather than a substitution of the
   * MSP one because the OFFER is different, not the vocabulary: the msp track
   * asks an operator for their read on the market, and this one proposes a
   * two-way referral relationship. Word-swapping the msp copy would produce a
   * fluent message that makes the wrong ask.
   */
  goldAdvisor: string;
  personaAnglesAdvisor: string;
  perspectiveAdvisor: string;
  subjectShapesAdvisor: string;
};

export type WorkspaceProfile = WorkspaceIdentity & {
  vocab: WorkspaceVocab;
  copy: DraftCopy;
};

// Cohesium's values. These are the literal strings that were inline in
// lib/sourcing/prompts.ts and lib/drafting/prompt.ts before this file existed —
// changing one here changes what Cohesium sends.
export const DEFAULT_IDENTITY: WorkspaceIdentity = {
  firmName: "Cohesium",
  senderName: "Ripley",
  senderIntro: "I'm a cofounder of Cohesium, an investment firm",
  approach:
    "We learn a market by talking with the people running it day to day, and it lets us build a network of operators we can be useful to over time.",
  approachDetailed:
    "we learn a market by talking with the experienced\n  people running it, about what matters and what pain points still need solving,\n  and it lets us build a network of sharp operators we can be useful to over time,\n  through intros, hiring, and advisor roles.",
};

/**
 * "a" or "an" for a market term.
 *
 * English picks the article by SOUND, and the provider terms are the one place a
 * tenant's vocabulary changes which one is right: "an MSP" (em) but "a TPA"
 * (tee); "a managed IT service provider" but "an insurance brokerage". The
 * prompts hardcoded "an", which is correct for Cohesium and produced "an TPA"
 * throughout Ilium's — exactly the tell that makes outreach read as generated.
 *
 * An ALL-CAPS term is read letter by letter, so its article follows the first
 * LETTER'S NAME: A, E, F, H, I, L, M, N, O, R, S and X start with a vowel sound.
 * Anything else is an ordinary word, judged by its first letter. The irregular
 * cases English keeps ("a university") are beyond a helper this size; a tenant
 * that hits one can word around it in Settings.
 */
export function articleFor(term: string): "a" | "an" {
  const first = term.trim().split(/[\s-]/)[0] ?? "";
  if (!first) return "a";
  if (/^[A-Z]{2,}$/.test(first)) return "AEFHILMNORSX".includes(first[0]) ? "an" : "a";
  return /^[aeiou]/i.test(first) ? "an" : "a";
}

export const DEFAULT_VOCAB: WorkspaceVocab = {
  providerSingular: "managed IT service provider",
  providerPlural: "managed IT service providers",
  providerAbbrev: "MSP",
  providerAbbrevPlural: "MSPs",
  providerGeneric: "managed IT provider",
  market: "managed IT market",
  marketShort: "managed IT",
  customerFunction: "IT",
  providerCasual: "IT provider",
  channelSingular: "referral partner",
  channelPlural: "referral partners",
  channelAbbrev: "partner",
  channelAbbrevPlural: "partners",
};

/**
 * The channel track's copy, shared by every tenant that has not overridden it.
 *
 * Unlike the msp/customer blocks this is NOT market-specific prose. The ask —
 * "we buy firms like the ones you advise, and we can send owners back to you" —
 * has the same shape in any market, and the market words arrive through the
 * vocabulary tokens. So one block serves as both the neutral default and
 * Cohesium's, which also keeps the leak detector honest: a tenant that has not
 * written its own channel example has nothing to leak.
 */
const CHANNEL_COPY = {
  goldAdvisor: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: {{firmName}} + your {{providerAbbrev}} relationships

Hi Dana,

Your name came up alongside a couple of the {{providerAbbrevPlural}} we know well, and the
overlap seemed worth a note.

{{senderIntro}}. We buy {{providerPlural}} outright, so if an owner you advise ever
raises succession or liquidity, there is a real home for that firm. And when we
do acquire one, that owner walks away liquid and looking for advice.

Worth a short call to see whether this is useful in either direction?

Thanks,
{{senderName}}

LinkedIn —
Hi Alex, {{senderIntro}}. We buy {{providerPlural}} outright, and it looks like we
work around some of the same firms. If an owner you advise ever raises
succession, there is a home for that business. Worth a quick chat?`,

  personaAnglesAdvisor: `Persona angle (the relevance hook)
Everyone on this track is {{channelSingular}} or a principal at one of these firms. The
persona key is a schema literal, not a description of the person, so read it as
seniority within the practice rather than as a job function:
- owner: a principal or partner of the practice. This is the main audience. The
  angle is what a succession conversation with an owner they advise looks
  like, and what that owner is looking for on the other side of a sale.
- head_of_it: someone at the firm who is not a principal, or whoever runs the
  relationships day to day. Same proposition, one level down.
- other: a neutral version of the owner angle.`,

  perspectiveAdvisor: "how a {{channelSingular}} and a buyer of {{providerPlural}} can be useful to each other",

  subjectShapesAdvisor: `"{{firmName}} + your {{providerAbbrev}} relationships", "succession on the {{providerAbbrev}} side",
  "{{firmName}} + <company>"`,
} as const;

/**
 * Cohesium's own prose — the text that was inline in lib/drafting/prompt.ts and
 * was the default until migration 039.
 *
 * It stopped being the default because it is not generic, it is Cohesium's:
 * "growing pediatric practices", "the mid-Atlantic", "the MSP market". Those
 * fragments are why the examples cannot be word-substituted for another firm,
 * and inheriting them would frame a staffing firm's outreach around managed IT.
 *
 * Kept here, and seeded into Cohesium's workspace_profile by 039, so their
 * prompts do not change by a single byte. The cohesium_* golden fixtures prove
 * exactly that.
 */
export const COHESIUM_COPY: DraftCopy = {
  approachInline:
    "We learn a market by talking with the people running it day to\nday, and it lets us build a network of operators we can be useful to over time.",
  approachBullet:
    "We learn a\n  market by talking with the people running it day to day, and it lets us build a\n  network of operators we can be useful to over time.",

  goldCustomer: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: quick question on your IT setup

Hi Trish,

I've been digging into how growing pediatric practices actually work with their
managed IT providers, where it helps and where it just adds overhead, and figured
someone in your seat would have a clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you'd have a few minutes in the next week or two? I'm not selling
anything, just trying to understand the space.

Thanks,
{{senderName}}

LinkedIn —
Hi Jim, {{senderIntro}} researching how companies work with their managed IT
providers, and your read from the practice side would be useful. Open to a quick
chat in the next week or two? Not selling anything.`,

  goldMsp: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: your take on the MSP market

Hi Tom,

I've been talking with people who've built managed IT businesses in the
mid-Atlantic about where the market is heading, what's getting harder, what
still makes the model work, and figured a founder in your seat would have a
clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you'd have a few minutes in the next week or two? I'm not selling
anything, just trying to understand the business from the operator's side.

Thanks,
{{senderName}}

LinkedIn —
Hi Sam, {{senderIntro}} researching the managed IT market from the operator's
side, and your read on where things are heading for MSPs would be useful. Open
to a quick chat? Not selling anything.`,

  personaAnglesCustomer: `Persona angle (the relevance hook)
- owner: keeping technology and security dependable as the business grows,
  without IT becoming a distraction.
- head_of_it: where managed services genuinely help versus where they just
  commoditize the work.
- other: a neutral version of the owner angle.`,

  personaAnglesMsp: `Persona angle (the relevance hook)
- owner: what it takes to build and grow a healthy MSP right now, from pricing
  pressure to talent to the security workload, and where the market is heading.
- head_of_it: how service delivery is changing, with tooling and automation,
  versus what clients actually value and will pay for.
- other: a neutral version of the owner angle.`,

  perspectiveCustomer: "how companies like theirs work with managed IT",
  perspectiveMsp: "what it takes to run a managed IT business today",

  // {{firmName}} rather than the literal: a workspace that renames the firm but
  // keeps the default subject shapes would otherwise be told to write another
  // firm's name into its subject lines.
  subjectShapesCustomer: `"quick question on your IT setup", "your take on managed IT",
  "{{firmName}} + <company>"`,
  subjectShapesMsp: `"your take on the MSP market", "the state of managed IT",
  "{{firmName}} + <company>"`,
  ...CHANNEL_COPY,
};

/**
 * The default worked examples: same voice and shape, no borrowed market.
 *
 * Every market-bound fragment is either tokenised or generalised. What remains
 * is the part that actually transfers — the register, the three-paragraph
 * shape, the soft ask, the LinkedIn brevity — which is the reason the block
 * exists at all. The Email and LinkedIn rules already specify structure in
 * detail, so what these add is mostly voice.
 *
 * They are deliberately less vivid than COHESIUM_COPY. A specific example is a
 * stronger teacher (12% of Cohesium's drafts adopted its opener), but a
 * specific example from the WRONG market is a strong teacher of the wrong
 * thing, and that failure is silent: it produces a fluent, well-formed message
 * framed around a market the recipient is not in. Nothing in the honesty rules
 * catches that, because no fact was fabricated.
 *
 * A workspace that writes its own examples should — that is what `copy` is for.
 */
export const DEFAULT_COPY: DraftCopy = {
  approachInline:
    "We learn a market by talking with the people running it day to\nday, and it lets us build a network of operators we can be useful to over time.",
  approachBullet:
    "We learn a\n  market by talking with the people running it day to day, and it lets us build a\n  network of operators we can be useful to over time.",

  goldCustomer: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: quick question on your {{marketShort}} setup

Hi Trish,

I've been digging into how companies like yours actually work with their
{{providerGeneric}}s, where it helps and where it just adds overhead, and figured
someone in your seat would have a clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you'd have a few minutes in the next week or two? I'm not selling
anything, just trying to understand the space.

Thanks,
{{senderName}}

LinkedIn —
Hi Jim, {{senderIntro}} researching how companies work with their
{{providerGeneric}}s, and your read from the inside would be useful. Open to a quick
chat in the next week or two? Not selling anything.`,

  goldMsp: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: your take on the {{market}}

Hi Tom,

I've been talking with people who've built {{providerPlural}} about where the
market is heading, what's getting harder, what still makes the model work, and
figured a founder in your seat would have a clear read on it.

{{senderIntro}}. {{approachInline}}

Any chance you'd have a few minutes in the next week or two? I'm not selling
anything, just trying to understand the business from the operator's side.

Thanks,
{{senderName}}

LinkedIn —
Hi Sam, {{senderIntro}} researching the {{market}} from the operator's
side, and your read on where things are heading for {{providerAbbrevPlural}} would be useful. Open
to a quick chat? Not selling anything.`,

  personaAnglesCustomer: `Persona angle (the relevance hook)
- owner: keeping the operation dependable as the business grows, without this
  becoming a distraction from the work itself.
- head_of_it: where an outside provider genuinely helps versus where it just
  commoditizes the work.
- other: a neutral version of the owner angle.`,

  personaAnglesMsp: `Persona angle (the relevance hook)
- owner: what it takes to build and grow a healthy {{providerAbbrev}} right now, from
  pricing pressure to talent to workload, and where the market is heading.
- head_of_it: how service delivery is changing, with tooling and automation,
  versus what clients actually value and will pay for.
- other: a neutral version of the owner angle.`,

  perspectiveCustomer: "how companies like theirs work with a {{providerGeneric}}",
  perspectiveMsp: "what it takes to run a {{providerSingular}} today",

  subjectShapesCustomer: `"quick question on your {{marketShort}} setup", "your take on {{marketShort}}",
  "{{firmName}} + <company>"`,
  subjectShapesMsp: `"your take on the {{market}}", "the state of {{marketShort}}",
  "{{firmName}} + <company>"`,
  ...CHANNEL_COPY,
};

/**
 * Substitute {{tokens}} in a copy block. Function replacement so a value
 * containing a $ is inserted literally, and one pass only so a substituted
 * value is never itself rescanned for tokens.
 */
export function renderCopy(text: string, p: WorkspaceProfile): string {
  const values: Record<string, string> = {
    firmName: p.firmName,
    senderName: p.senderName,
    senderIntro: p.senderIntro,
    // `approach` is the single source for "why you're reaching out": the tenant
    // default (workspace_profile.approach), overlaid with the sender's own
    // per-workspace override (member_sender.approach) at draft time. The older
    // pre-wrapped copy blocks (approachInline/approachBullet) and the code-level
    // approachDetailed all now render from this one field, so editing it — as
    // admin default or as a personal override — actually changes the message.
    approach: p.approach,
    approachDetailed: p.approach,
    approachInline: p.approach,
    approachBullet: p.approach,
    ...p.vocab,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m);
}

export const DEFAULT_PROFILE: WorkspaceProfile = {
  ...DEFAULT_IDENTITY,
  vocab: DEFAULT_VOCAB,
  copy: DEFAULT_COPY,
};

/** Fill any missing field from the defaults, so a partial row still builds a prompt. */
export function completeProfile(partial: Partial<WorkspaceProfile> | null): WorkspaceProfile {
  if (!partial) return DEFAULT_PROFILE;
  return {
    ...DEFAULT_PROFILE,
    ...partial,
    vocab: { ...DEFAULT_VOCAB, ...(partial.vocab ?? {}) },
    copy: { ...DEFAULT_COPY, ...(partial.copy ?? {}) },
  };
}
