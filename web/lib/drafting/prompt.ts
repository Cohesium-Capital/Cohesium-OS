// Builds the drafting prompt you paste into Claude/ChatGPT (web search on, so it
// can personalize from a real company detail). Returns JSON matching
// lib/drafting/contracts.ts, pasted back into the draft importer.

// Edit SENDER to change how the sender introduces themselves. Keep it honest.
export const SENDER = {
  name: "Ripley",
  // The one-line "who I am". Refer to the firm only as "Cohesium".
  intro: "I'm a cofounder of Cohesium, an investment firm",
};

export type DraftContact = {
  contact_id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  company_name: string;
  company_domain: string | null;
  city: string | null;
  current_msp: string | null;
  channels: ("email" | "linkedin")[];
};

const HEADER = `You draft warm cold-outreach for ${SENDER.name} at Cohesium. Each recipient
runs or leads IT at a company that uses a managed IT service provider (an MSP).
The goal is an honest ask for a short conversation about how companies like
theirs work with their IT provider. ${SENDER.name} is genuinely researching the
managed IT market and is not selling anything.

For EACH contact listed below, draft a message for EACH channel on that contact's
line. Return ONLY a single JSON object, no markdown and no commentary:

{
  "drafts": [
    { "contact_id": string, "channel": "email" | "linkedin", "subject": string | null, "body": string }
  ]
}

Use the exact contact_id from each line. Sign emails as ${SENDER.name}. "subject"
is a short line for email and null for linkedin.`;

// One worked example per channel. Showing the voice beats describing it, and it
// is the surest way to stop the model from leaking a meta-label like "this is a
// cold email" as a subject or body line.
const GOLD = `Gold examples (imitate this voice and shape, never copy the facts)

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
Hi Jim, apologies for the cold note. ${SENDER.intro} researching how companies
work with their managed IT providers. Would value your take. Open to a quick chat
in the next week or two? Not selling anything.`;

const RULES = `Structure (model this on warm investor outreach that works)
- Open with relevance to the recipient. Where the opener goes differs by channel
  (see the per-channel sections below): an email leads with relevance, while a
  LinkedIn note may open with a brief apology. Do NOT label the message: never
  write "this is a cold email", "cold note", "[subject]", or any placeholder as a
  subject or a line of the body.
- Say who you are in one line: "${SENDER.intro}".
- Give the approach briefly: we learn a market by talking with the experienced
  people running it, about what matters and what pain points still need solving,
  and it lets us build a network of sharp operators we can be useful to over time,
  through intros, hiring, and advisor roles.
- Personalize with ONE true, verifiable detail, and strongly prefer something
  from the LAST 12 MONTHS: a recent talk, panel, podcast, or conference
  appearance (speaking engagements are especially good), a recent company
  announcement or news, or a recent post. Then credit their perspective on how
  companies like theirs work with managed IT.
- VERIFY every specific claim with web search before using it. Only state a fact
  you can confirm from a citable source. If you cannot verify a recent, specific
  detail, do not invent one. Open with an honest observation about their role or
  industry instead.
- Close with a soft ask: a few minutes to chat in the next week or two, and say
  plainly you are not selling anything.

Persona angle (the relevance hook)
- owner: keeping technology and security dependable as the business grows,
  without IT becoming a distraction.
- head_of_it: where managed services genuinely help versus where they just
  commoditize the work.
- other: a neutral version of the owner angle.

Email
- 80 to 120 words, never over 130 (count them). Three SHORT paragraphs separated
  by a blank line:
  (1) "Hi <first name>," then open with relevance to the recipient: the persona
  angle, plus the verified personalization hook if one is provided. The first
  sentence must be about them or about what you are researching in their world. It
  must never be about you and never an apology.
  (2) Who you are and why it is worth their time: "${SENDER.intro}". We learn a
  market by talking with the people running it day to day, and it lets us build a
  network of operators we can be useful to over time.
  (3) The soft ask, and that you are not selling anything. A brief, light
  acknowledgment that you came in cold is optional and goes here only, never in
  paragraph one and never in the subject.
  Sign off with "Thanks," then "${SENDER.name}" on their own lines.
- The first sentence is about the recipient, not about us. No apology and no
  self-introduction in the first sentence.
- With a verified hook, lead the first sentence with it. With no hook, lead with a
  true observation about their role or industry. Never use an apology as a stand-in
  for relevance.
- Subject: short and specific, ideally under 40 characters, written to look like
  a note a colleague would send. A light question or a plain topic works. Good
  shapes: "quick question on your IT setup", "your take on managed IT",
  "Cohesium + <company>". Never put "sorry", "apologies", or "cold" in the subject.
  Never use the words free or guaranteed, a fake "Re:", all caps, or exclamation
  points.

LinkedIn
- No subject. The body is a HARD 300-character maximum including spaces; aim for
  roughly 180 to 260. One line of who you are and what you are researching, then
  one light ask whose only job is to earn the accept, not to pitch. Count the
  characters and keep it tight — a note over 300 will be rejected.

Voice: direct, warm, conversational, a little humble. No em-dashes. No
semicolons. No bullet points. No corporate filler. It must read as written by a
person. Never open with "I hope this finds you well" or "My name is". Refer to
the firm only as "Cohesium".

Honesty: never invent a detail, event, mutual connection, or claim. With no
verifiable detail, open with an honest observation about their role or industry
rather than a fabricated specific. Plain and credible beats clever.

${GOLD}

Before you return the JSON, re-read every draft and fix any that fail: no
meta-label or placeholder as a subject or a body line, the personalized detail is
real and verifiable (or replaced with an honest role/industry observation), each
email is 80 to 120 words (never over 130) with a subject under ~40 characters and
no spam words, each LinkedIn body is 300 characters or fewer, and there are no
em-dashes, semicolons, bullet points, or filler. Quality over quantity — if you
cannot personalize a contact honestly, keep it simple and credible rather than
clever.`;

function renderContactLines(contacts: DraftContact[]): string {
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
        c.current_msp ? `current_msp=${c.current_msp}` : "",
        `channels: ${c.channels.join(", ")}`,
      ].filter(Boolean);
      return parts.join("; ");
    })
    .join("\n");
}

export function buildDraftPrompt(contacts: DraftContact[]): string {
  return [HEADER, "", RULES, "", "Contacts:", renderContactLines(contacts)].join("\n");
}

// Orchestration prompt for Claude Code: instead of pasting one chunk into a chat,
// hand the WHOLE list to Claude Code and let it fan the work out to subagents,
// each web-researching and drafting a slice, then merge into one drafts JSON to
// paste back into the importer. Same per-message rules and JSON contract as the
// single-shot prompt above.
export function buildDraftAgentPrompt(
  contacts: DraftContact[],
  chunkSize = 15,
): string {
  const n = contacts.length;
  const chunks = Math.max(1, Math.ceil(n / chunkSize));
  const orchestration = `You are running a batch cold-outreach drafting job in Claude Code for
${SENDER.name} at Cohesium. There are ${n} contacts below. Do NOT draft them all
yourself in one pass — fan the work out so each message gets real research:

1. Split the ${n} contacts into ${chunks} chunk(s) of up to ${chunkSize}.
2. Spawn one subagent per chunk with the Task tool, running them in parallel.
   Give each subagent its slice of contact lines, the rules below, and the
   instruction to use web search.
3. Each subagent, for every contact in its slice, web-researches ONE true,
   verifiable, recent detail and drafts a message for EACH channel on that
   contact's line, following the rules below exactly. It returns a JSON array of
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

  return [orchestration, "", RULES, "", `Contacts (${n}):`, renderContactLines(contacts)].join(
    "\n",
  );
}
