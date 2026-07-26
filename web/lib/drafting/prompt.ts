// Builds the drafting prompt you paste into Claude/ChatGPT. Personalization
// arrives pre-researched: a contact line may carry a verified hook= claim or an
// honest fallback_angle= from the Personalize stage, so drafting is pure
// writing — no draft-time web research. Returns JSON matching
// lib/drafting/contracts.ts, pasted back into the draft importer.
//
// Two tracks, one honest premise. The pipeline carries two audiences that need
// different registers:
//   - "customer": people who run or lead IT at a company that USES an MSP —
//     the conversation is about how they work with their IT provider.
//   - "msp": people who own or run an MSP — the acquisition targets. The
//     conversation is about building and operating an MSP, from the operator's
//     side. Never frame them as someone else's IT customer.
// Batches are single-track by construction (the Draft page separates them), so
// each generated prompt speaks one register throughout.

// Edit SENDER to change how the sender introduces themselves. Keep it honest.
export const SENDER = {
  name: "Ripley",
  // The one-line "who I am". Refer to the firm only as "Cohesium".
  intro: "I'm a cofounder of Cohesium, an investment firm",
};

export type TrackKind = "msp" | "customer";

export type DraftContact = {
  contact_id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  company_name: string;
  company_domain: string | null;
  city: string | null;
  current_msp: string | null;
  org_kind: string | null; // 'msp' (acquisition target) | 'customer' | 'unknown' (legacy default)
  channels: ("email" | "linkedin")[];
  // Personalization from the hook stage (step 4): the contact's latest usable
  // hook, resolved server-side (lib/hooks/usable.ts). hook_id is provenance
  // only — never rendered into the prompt, it stamps touches.hook_id at import
  // so hook usage is derived from touches, not from a status flip.
  hook_id?: string | null;
  hook_text?: string | null; // the verified claim; null when kind='none'
  hook_source_url?: string | null;
  hook_kind?: string | null;
  fallback_angle?: string | null; // honest opener when no verifiable hook exists
};

// The JSON contract is shared by both tracks; only the recipient framing forks.
const HEADER_FRAMING: Record<TrackKind, string> = {
  customer: `You draft warm first-touch outreach for ${SENDER.name} at Cohesium. Each recipient
runs or leads IT at a company that uses a managed IT service provider (an MSP).
The goal is an honest ask for a short conversation about how companies like
theirs work with their IT provider. ${SENDER.name} is genuinely researching the
managed IT market and is not selling anything.`,
  msp: `You draft warm first-touch outreach for ${SENDER.name} at Cohesium. Each recipient
owns or helps run a managed IT service provider (an MSP). The goal is an honest
ask for a short conversation about what it takes to build and operate an MSP
today, from the operator's side. ${SENDER.name} is genuinely researching the
managed IT market and is not selling anything.`,
};

const HEADER_CONTRACT = `For EACH contact listed below, draft a message for EACH channel on that contact's
line. Return ONLY a single JSON object, no markdown and no commentary:

{
  "drafts": [
    { "contact_id": string, "channel": "email" | "linkedin", "subject": string | null, "body": string }
  ]
}

Use the exact contact_id from each line. Sign emails as ${SENDER.name}. "subject"
is a short line for email and null for linkedin.`;

function header(kind: TrackKind): string {
  return [HEADER_FRAMING[kind], "", HEADER_CONTRACT].join("\n");
}

// One worked example per channel. Showing the voice beats describing it, and it
// is the surest way to stop the model from leaking a meta-label like "this is a
// cold email" as a subject or body line.
const GOLD: Record<TrackKind, string> = {
  customer: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: quick question on your IT setup

Hi Trish,

I've been digging into how growing pediatric practices actually work with their
managed IT providers, where it helps and where it just adds overhead, and figured
someone in your seat would have a clear read on it.

${SENDER.intro}. We learn a market by talking with the people running it day to
day, and it lets us build a network of operators we can be useful to over time.

Any chance you'd have a few minutes in the next week or two? I'm not selling
anything, just trying to understand the space.

Thanks,
${SENDER.name}

LinkedIn —
Hi Jim, ${SENDER.intro} researching how companies work with their managed IT
providers, and your read from the practice side would be useful. Open to a quick
chat in the next week or two? Not selling anything.`,
  msp: `Gold examples (imitate this voice and shape, never copy the facts)

Email —
Subject: your take on the MSP market

Hi Tom,

I've been talking with people who've built managed IT businesses in the
mid-Atlantic about where the market is heading, what's getting harder, what
still makes the model work, and figured a founder in your seat would have a
clear read on it.

${SENDER.intro}. We learn a market by talking with the people running it day to
day, and it lets us build a network of operators we can be useful to over time.

Any chance you'd have a few minutes in the next week or two? I'm not selling
anything, just trying to understand the business from the operator's side.

Thanks,
${SENDER.name}

LinkedIn —
Hi Sam, ${SENDER.intro} researching the managed IT market from the operator's
side, and your read on where things are heading for MSPs would be useful. Open
to a quick chat? Not selling anything.`,
};

// The relevance hook per persona, forked by track: customer personas talk about
// living with an IT provider; MSP personas talk about running the business.
const PERSONA_ANGLES: Record<TrackKind, string> = {
  customer: `Persona angle (the relevance hook)
- owner: keeping technology and security dependable as the business grows,
  without IT becoming a distraction.
- head_of_it: where managed services genuinely help versus where they just
  commoditize the work.
- other: a neutral version of the owner angle.`,
  msp: `Persona angle (the relevance hook)
- owner: what it takes to build and grow a healthy MSP right now, from pricing
  pressure to talent to the security workload, and where the market is heading.
- head_of_it: how service delivery is changing, with tooling and automation,
  versus what clients actually value and will pay for.
- other: a neutral version of the owner angle.`,
};

// What we credit the recipient's perspective on, per track.
const PERSPECTIVE: Record<TrackKind, string> = {
  customer: "how companies like theirs work with managed IT",
  msp: "what it takes to run a managed IT business today",
};

function rules(kind: TrackKind, learned = ""): string {
  return `${learned ? `${learned}\n\n` : ""}Structure (model this on warm investor outreach that works)
- Open with relevance to the recipient, on every channel.
- NEVER acknowledge that the message is unsolicited. Write as one professional
  writing to another for the first time — which needs no apology and no framing.
  Banned in the subject and the body, in any wording: "cold" (cold note, cold
  email, reaching out cold), "apologies"/"sorry" for writing, "you don't know
  me", "out of the blue", "hope you don't mind", "forgive the intrusion",
  "random", "unsolicited". Do NOT label the message at all: never write "this is
  a cold email", "[subject]", or any placeholder as a subject or a body line.
- Say who you are in one line: "${SENDER.intro}".
- Give the approach briefly: we learn a market by talking with the experienced
  people running it, about what matters and what pain points still need solving,
  and it lets us build a network of sharp operators we can be useful to over time,
  through intros, hiring, and advisor roles.
- Personalization is PROVIDED, not researched. Drafting is pure writing: do NOT
  use web search, and do not add any specific claim beyond what a contact's
  line carries.
  - When a line carries hook=<claim>, that claim is ALREADY VERIFIED against
    its source. Open with it, then credit their perspective on
    ${PERSPECTIVE[kind]}. Do not embellish the claim and do not add any other
    specific claim.
  - When a line carries fallback_angle=<text>, research found NO verifiable
    hook for this person. Open with that honest observation. Never invent a
    specific detail to replace it.
  - When a line carries neither, open with an honest observation about their
    role or industry.
- Close with a soft ask: a few minutes to chat in the next week or two, and say
  plainly you are not selling anything.${
    kind === "customer"
      ? `
- A contact line may carry a current_msp=<name> token: that is the provider
  serving their company. Use it only as background for your framing — never name
  their provider in the message, and never imply you are checking up on it.`
      : ""
  }

${PERSONA_ANGLES[kind]}

Email
- 80 to 120 words, never over 130 (count them). Three SHORT paragraphs separated
  by a blank line:
  (1) "Hi <first name>," then open with relevance to the recipient: the persona
  angle, plus the provided hook (or fallback_angle) if the line carries one. The
  first sentence must be about them or about what you are researching in their
  world. It must never be about you and never an apology.
  (2) Who you are and why it is worth their time: "${SENDER.intro}". We learn a
  market by talking with the people running it day to day, and it lets us build a
  network of operators we can be useful to over time.
  (3) The soft ask, and that you are not selling anything. No apology for
  writing and no reference to how you found them.
  Sign off with "Thanks," then "${SENDER.name}" on their own lines.
- The first sentence is about the recipient, not about us. No apology anywhere
  in the message, and no self-introduction in the first sentence.
- With a hook= token, lead the first sentence with it. Otherwise lead with the
  fallback_angle= text or a true observation about their role or industry. Never
  use an apology as a stand-in for relevance.
- Subject: short and specific, ideally under 40 characters, written to look like
  a note a colleague would send. A light question or a plain topic works. Good
  shapes: ${
    kind === "customer"
      ? `"quick question on your IT setup", "your take on managed IT",
  "Cohesium + <company>"`
      : `"your take on the MSP market", "the state of managed IT",
  "Cohesium + <company>"`
  }. Never put "sorry", "apologies", or "cold" anywhere in the subject or body.
  Never use the words free or guaranteed, a fake "Re:", all caps, or exclamation
  points.

LinkedIn
- No subject. The body is a HARD 300-character maximum including spaces; aim for
  roughly 180 to 260. Open on them or on what you are researching in their world
  — never on an apology for writing — then one line of who you are, then one
  light ask whose only job is to earn the accept, not to pitch. Count the
  characters and keep it tight — a note over 300 will be rejected.

Voice: direct, warm, conversational, a little humble. No em-dashes. No
semicolons. No bullet points. No corporate filler. It must read as written by a
person. Never open with "I hope this finds you well" or "My name is". Refer to
the firm only as "Cohesium".

Honesty: never invent a detail, event, mutual connection, or claim, and never
add a specific claim that is not on the contact's line. With no hook provided,
open with an honest observation about their role or industry rather than a
fabricated specific. Plain and credible beats clever.

${GOLD[kind]}

Before you return the JSON, re-read every draft and fix any that fail: no
meta-label or placeholder as a subject or a body line, every specific claim
comes from that contact's hook= token and nowhere else (fallback and no-hook
drafts carry only honest role/industry observations, no specifics), each
email is 80 to 120 words (never over 130) with a subject under ~40 characters and
no spam words, each LinkedIn body is 300 characters or fewer, and there are no
em-dashes, semicolons, bullet points, or filler. Quality over quantity — if you
cannot personalize a contact honestly, keep it simple and credible rather than
clever.`;
}

function renderContactLines(contacts: DraftContact[], kind: TrackKind): string {
  return contacts
    .map((c, i) => {
      const company = c.company_domain
        ? `${c.company_name} (${c.company_domain})`
        : c.company_name;
      const parts = [
        `[${i + 1}] contact_id=${c.contact_id}`,
        `name=${c.full_name ?? "unknown"}`,
        `persona=${c.persona ?? "other"}`,
        c.title ? `title=${c.title}` : "",
        `company=${company}`,
        c.city ? `city=${c.city}` : "",
        // The current_msp token is customer-track context (and its handling
        // rule only exists there). On the msp track a stray value would invite
        // the model to frame an MSP owner as someone else's IT customer.
        kind === "customer" && c.current_msp ? `current_msp=${c.current_msp}` : "",
        // The personalization artifact: a verified hook claim (with its source
        // so the drafter can attribute naturally), or the honest no-hook angle.
        // A line never carries both — hook_text wins if a row somehow has both.
        c.hook_text
          ? `hook=${c.hook_text}${c.hook_source_url ? ` (source: ${c.hook_source_url})` : ""}`
          : c.fallback_angle
            ? `fallback_angle=${c.fallback_angle}`
            : "",
        `channels: ${c.channels.join(", ")}`,
      ].filter(Boolean);
      return parts.join("; ");
    })
    .join("\n");
}

// The static single-shot template for a track: everything except the batch's
// contact lines, which sit behind the {{contacts}} placeholder. This is the
// text the run lifecycle hashes (runs.template_hash) so a prompt version is
// identified by its instructions, not by whichever contacts were pasted in.
export function buildTemplateText(kind: TrackKind, learned = ""): string {
  return [header(kind), "", rules(kind, learned), "", "Contacts:", "{{contacts}}"].join("\n");
}

export function buildDraftPrompt(
  contacts: DraftContact[],
  kind: TrackKind = "customer",
  learned = "",
): string {
  return [
    header(kind),
    "",
    rules(kind, learned),
    "",
    "Contacts:",
    renderContactLines(contacts, kind),
  ].join("\n");
}

// Derive the track from a batch's contacts: msp only when the batch is
// uniformly MSP-side. Mixed or unknown batches fall back to the customer
// framing (the original register) — callers that can, should pass kind
// explicitly instead.
export function trackKindOf(contacts: DraftContact[]): TrackKind {
  return contacts.length > 0 && contacts.every((c) => c.org_kind === "msp")
    ? "msp"
    : "customer";
}

// Orchestration prompt for Claude Code: instead of pasting one chunk into a chat,
// hand the WHOLE list to Claude Code and let it fan the work out to subagents,
// each drafting a slice from the provided hooks (no research), then merge into
// one drafts JSON to paste back into the importer. Same per-message rules and
// JSON contract as the single-shot prompt above.
export function buildDraftAgentPrompt(
  contacts: DraftContact[],
  chunkSize = 15,
  kind: TrackKind = "customer",
  learned = "",
): string {
  const n = contacts.length;
  const chunks = Math.max(1, Math.ceil(n / chunkSize));
  const audience =
    kind === "msp"
      ? "Every contact below owns or helps run a managed IT service provider (an MSP) — the outreach is about operating an MSP, from the operator's side."
      : "Every contact below runs or leads IT at a company that uses a managed IT service provider — the outreach is about how they work with their IT provider.";
  const orchestration = `You are running a batch outreach drafting job in Claude Code for
${SENDER.name} at Cohesium. There are ${n} contacts below. ${audience}
Do NOT draft them all yourself in one pass — fan the work out so each message
gets focused attention. Personalization is already researched and verified:
lines carry hook= or fallback_angle= tokens, so no subagent uses web search.

1. Split the ${n} contacts into ${chunks} chunk(s) of up to ${chunkSize}.
2. Spawn one subagent per chunk with the Task tool, running them in parallel.
   Give each subagent its slice of contact lines and the rules below.
3. Each subagent, for every contact in its slice, drafts a message for EACH
   channel on that contact's line using ONLY what the line provides, following
   the rules below exactly. It returns a JSON array of
   { "contact_id", "channel", "subject", "body" } objects — nothing else.
4. When every subagent has returned, merge all of their drafts into ONE JSON
   object and print it as your FINAL message, with NO surrounding prose or
   markdown, so it can be pasted straight back into the importer:

{
  "drafts": [
    { "contact_id": string, "channel": "email" | "linkedin", "subject": string | null, "body": string }
  ]
}

Use the exact contact_id from each line. Sign emails as ${SENDER.name}. "subject"
is a short line for email and null for linkedin. Draft a message for every
channel listed on a contact's line.`;

  return [
    orchestration,
    "",
    rules(kind, learned),
    "",
    `Contacts (${n}):`,
    renderContactLines(contacts, kind),
  ].join("\n");
}
