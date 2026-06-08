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

const RULES = `Structure (model this on warm investor outreach that works)
- Open casually and acknowledge it is a cold email.
- Say who you are in one line: "${SENDER.intro}".
- Give the approach briefly: we learn by talking to experienced operators about
  what actually matters and what pain points still need solving in a market, and
  it lets us build a network of sharp people we can be useful to over time
  (intros, hiring, advisor roles).
- Personalize with ONE true, verifiable detail, and strongly prefer something
  from the LAST 12 MONTHS: a recent talk, panel, podcast, or conference
  appearance (speaking engagements are especially good), a recent company
  announcement or news, or a recent post. Then credit their perspective on how
  companies like theirs work with managed IT.
- VERIFY every specific claim with web search before using it. Only state a fact
  you can confirm from a citable source. If you cannot verify a recent, specific
  detail, do not invent one — open with an honest observation about their role or
  industry instead.
- Close with a soft ask: a few minutes to chat in the next week or two, and say
  plainly you are not selling anything.

Persona angle
- owner: keeping technology and security dependable as the business grows,
  without IT becoming a distraction.
- head_of_it: where managed services genuinely help versus where they just
  commoditize the work.
- other: a neutral version of the owner angle.

Length and channel
- email: keep it under about 130 words. Format as two or three SHORT paragraphs
  separated by a blank line: (1) "Hi <first name>," then a line or two on who you
  are and the approach, (2) one or two sentences of personalized relevance, (3)
  the ask. Sign off with "Thanks," then "${SENDER.name}" on their own lines. A
  short, specific subject line.
- linkedin: no subject, 300 characters maximum, one line of relevance and one
  light ask.

Voice: direct, warm, conversational, a little humble. No em-dashes. No
semicolons. No bullet points. No corporate filler. It must read as written by a
person.

Honesty: never invent a detail, event, mutual connection, or claim. Plain and
credible beats clever. Refer to the firm only as "Cohesium".`;

export function buildDraftPrompt(contacts: DraftContact[]): string {
  const lines = contacts.map((c, i) => {
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
  });

  return [HEADER, "", RULES, "", "Contacts:", lines.join("\n")].join("\n");
}
