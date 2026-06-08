// Builds the drafting prompt you paste into Claude/ChatGPT (web search on, so it
// can personalize from a real company detail). It returns JSON matching
// lib/drafting/contracts.ts, which you paste back into the draft importer.

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

const HEADER = `You draft outbound messages for Cohesium Capital's MSP-market research
outreach. Each recipient runs or leads IT at a company that uses a managed IT
service provider (an MSP). The purpose is an honest conversation about how
companies like theirs work with their IT provider. We are genuinely studying the
MSP market.

For EACH contact listed below, draft a message for EACH channel listed on that
contact's line. Return ONLY a single JSON object, no markdown and no commentary:

{
  "drafts": [
    { "contact_id": string, "channel": "email" | "linkedin", "subject": string | null, "body": string }
  ]
}

Use the exact contact_id from each line. "subject" is a short line for email, and
null for linkedin.`;

const RULES = `Framing
- The ask is light: a brief conversation or their perspective. Not a sales pitch,
  not a demo, not a hard push for a meeting.
- Never reveal or imply that we acquire MSPs or have any interest in their vendor
  beyond understanding the market. The stated reason is the whole message.
- Lead with relevance to them, then a small, easy ask.

Persona angle
- owner: keeping their technology and security dependable as the business grows,
  without IT becoming a distraction. Peer tone, one operator to another.
- head_of_it: where managed services genuinely help versus where they just
  commoditize the work, and how teams like theirs draw that line. Respect their
  expertise rather than threatening it.
- other: a neutral version of the owner angle.

Channel constraints
- email: a subject line plus three to five sentences. Specific, human, skimmable.
- linkedin: no subject, 300 characters maximum, one clear line of relevance and
  one light ask.

Voice
- Direct, confident, conversational. No em-dashes. No semicolons. No bullet
  points. No corporate filler. It must read as written by a person.

Personalization and honesty
- You MAY open with ONE true, verifiable detail about the contact's company (from
  its website or recent, citable news). NEVER invent a detail, an event, a mutual
  connection, or a claim. If you cannot verify something specific, open with an
  honest observation relevant to their role or industry instead.
- Use the contact's name naturally when provided. Plain and credible beats clever.
  Do not flatter or over-claim.`;

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
