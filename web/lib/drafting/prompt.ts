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

import {
  DEFAULT_PROFILE,
  renderCopy,
  type WorkspaceProfile,
} from "../workspace/identity";

// Who is writing, and what they call the market. Defaults to Cohesium's values,
// which are the exact strings that used to be inline here — see
// lib/workspace/identity.ts and the golden fixtures that pin them.
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
const headerFraming = (kind: TrackKind, p: WorkspaceProfile): string => {
  const v = p.vocab;
  return kind === "customer"
    ? `You draft warm first-touch outreach for ${p.senderName} at ${p.firmName}. Each recipient
runs or leads IT at a company that uses a ${v.providerSingular} (an ${v.providerAbbrev}).
The goal is an honest ask for a short conversation about how companies like
theirs work with their IT provider. ${p.senderName} is genuinely researching the
${v.market} and is not selling anything.`
    : `You draft warm first-touch outreach for ${p.senderName} at ${p.firmName}. Each recipient
owns or helps run a ${v.providerSingular} (an ${v.providerAbbrev}). The goal is an honest
ask for a short conversation about what it takes to build and operate an ${v.providerAbbrev}
today, from the operator's side. ${p.senderName} is genuinely researching the
${v.market} and is not selling anything.`;
};

const headerContract = (p: WorkspaceProfile) => `For EACH contact listed below, draft a message for EACH channel on that contact's
line. Return ONLY a single JSON object, no markdown and no commentary:

{
  "drafts": [
    { "contact_id": string, "channel": "email" | "linkedin", "subject": string | null, "body": string }
  ]
}

Use the exact contact_id from each line. Sign emails as ${p.senderName}. "subject"
is a short line for email and null for linkedin.`;

function header(kind: TrackKind, p: WorkspaceProfile): string {
  return [headerFraming(kind, p), "", headerContract(p)].join("\n");
}

// One worked example per channel. Showing the voice beats describing it, and it
// is the surest way to stop the model from leaking a meta-label like "this is a
// cold email" as a subject or body line.
const gold = (kind: TrackKind, p: WorkspaceProfile): string =>
  renderCopy(kind === "customer" ? p.copy.goldCustomer : p.copy.goldMsp, p);

function rules(kind: TrackKind, p: WorkspaceProfile, learned = ""): string {
  const pick = (c: string, m: string) => renderCopy(kind === "customer" ? c : m, p);
  const personaAngles = pick(p.copy.personaAnglesCustomer, p.copy.personaAnglesMsp);
  const perspective = pick(p.copy.perspectiveCustomer, p.copy.perspectiveMsp);
  const subjectShapes = pick(p.copy.subjectShapesCustomer, p.copy.subjectShapesMsp);
  return `${learned ? `${learned}\n\n` : ""}Structure (model this on warm investor outreach that works)
- Open with relevance to the recipient, on every channel.
- NEVER acknowledge that the message is unsolicited. Write as one professional
  writing to another for the first time — which needs no apology and no framing.
  Banned in the subject and the body, in any wording: "cold" (cold note, cold
  email, reaching out cold), "apologies"/"sorry" for writing, "you don't know
  me", "out of the blue", "hope you don't mind", "forgive the intrusion",
  "random", "unsolicited". Do NOT label the message at all: never write "this is
  a cold email", "[subject]", or any placeholder as a subject or a body line.
- Say who you are in one line: "${p.senderIntro}".
- Give the approach briefly: ${p.approachDetailed}
- Personalization is PROVIDED, not researched. Drafting is pure writing: do NOT
  use web search, and do not add any specific claim beyond what a contact's
  line carries.
  - When a line carries hook=<claim>, that claim is ALREADY VERIFIED against
    its source. Open with it, then credit their perspective on
    ${perspective}. Do not embellish the claim and do not add any other
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

${personaAngles}

Email
- 80 to 120 words, never over 130 (count them). Three SHORT paragraphs separated
  by a blank line:
  (1) "Hi <first name>," then open with relevance to the recipient: the persona
  angle, plus the provided hook (or fallback_angle) if the line carries one. The
  first sentence must be about them or about what you are researching in their
  world. It must never be about you and never an apology.
  (2) Who you are and why it is worth their time: "${p.senderIntro}". ${p.copy.approachBullet}
  (3) The soft ask, and that you are not selling anything. No apology for
  writing and no reference to how you found them.
  Sign off with "Thanks," then "${p.senderName}" on their own lines.
- The first sentence is about the recipient, not about us. No apology anywhere
  in the message, and no self-introduction in the first sentence.
- With a hook= token, lead the first sentence with it. Otherwise lead with the
  fallback_angle= text or a true observation about their role or industry. Never
  use an apology as a stand-in for relevance.
- Subject: short and specific, ideally under 40 characters, written to look like
  a note a colleague would send. A light question or a plain topic works. Good
  shapes: ${subjectShapes}. Never put "sorry", "apologies", or "cold" anywhere in the subject or body.
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
the firm only as "${p.firmName}".

Honesty: never invent a detail, event, mutual connection, or claim, and never
add a specific claim that is not on the contact's line. With no hook provided,
open with an honest observation about their role or industry rather than a
fabricated specific. Plain and credible beats clever.

${gold(kind, p)}

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
export function buildTemplateText(
  kind: TrackKind,
  learned = "",
  p: WorkspaceProfile = DEFAULT_PROFILE,
): string {
  return [header(kind, p), "", rules(kind, p, learned), "", "Contacts:", "{{contacts}}"].join("\n");
}

export function buildDraftPrompt(
  contacts: DraftContact[],
  kind: TrackKind = "customer",
  learned = "",
  p: WorkspaceProfile = DEFAULT_PROFILE,
): string {
  return [
    header(kind, p),
    "",
    rules(kind, p, learned),
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
  p: WorkspaceProfile = DEFAULT_PROFILE,
): string {
  const v = p.vocab;
  const n = contacts.length;
  const chunks = Math.max(1, Math.ceil(n / chunkSize));
  const audience =
    kind === "msp"
      ? `Every contact below owns or helps run a ${v.providerSingular} (an ${v.providerAbbrev}) — the outreach is about operating an ${v.providerAbbrev}, from the operator's side.`
      : `Every contact below runs or leads IT at a company that uses a ${v.providerSingular} — the outreach is about how they work with their IT provider.`;
  const orchestration = `You are running a batch outreach drafting job in Claude Code for
${p.senderName} at ${p.firmName}. There are ${n} contacts below. ${audience}
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

Use the exact contact_id from each line. Sign emails as ${p.senderName}. "subject"
is a short line for email and null for linkedin. Draft a message for every
channel listed on a contact's line.`;

  return [
    orchestration,
    "",
    rules(kind, p, learned),
    "",
    `Contacts (${n}):`,
    renderContactLines(contacts, kind),
  ].join("\n");
}
