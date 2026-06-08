export const meta = {
  name: "draft-messages",
  description:
    "Fan out one agent per contact to draft persona-aware outreach (web-search personalized); returns drafts for headless storage.",
  phases: [{ title: "Draft", detail: "one agent per contact, in parallel" }],
};

// args: { contacts: [{ contact_id, full_name, persona, title, company_name,
//   company_domain, city, current_msp, channels: ["email","linkedin"] }] }
// Returns: { drafts: [{ contact_id, channel, subject, body }] }

// Edit SENDER to change how the sender introduces themselves.
const SENDER = {
  name: "Ripley",
  intro: "I'm a cofounder of Cohesium, an investment firm",
};

const DRAFT_SCHEMA = {
  type: "object",
  required: ["drafts"],
  properties: {
    drafts: {
      type: "array",
      items: {
        type: "object",
        required: ["channel", "body"],
        properties: {
          channel: { type: "string", enum: ["email", "linkedin"] },
          subject: { type: ["string", "null"] },
          body: { type: "string" },
        },
      },
    },
  },
};

function draftPrompt(c) {
  const company = c.company_domain
    ? `${c.company_name} (${c.company_domain})`
    : c.company_name;
  return `You draft warm cold-outreach for ${SENDER.name} at Cohesium. The recipient runs or leads IT at a company that uses a managed IT service provider (an MSP). The goal is an honest ask for a short conversation about how companies like theirs work with their IT provider. ${SENDER.name} is genuinely researching the managed IT market and is not selling anything.

Draft a message for EACH of these channels: ${c.channels.join(", ")}.

Recipient:
- name: ${c.full_name || "unknown"}
- persona: ${c.persona || "other"}
- title: ${c.title || "unknown"}
- company: ${company}
- city: ${c.city || "unknown"}
- current MSP: ${c.current_msp || "unknown"}

Structure (model this on warm investor outreach that works)
- Open casually and acknowledge it is a cold email.
- Say who you are in one line: "${SENDER.intro}".
- Approach, briefly: we learn by talking to experienced operators about what actually matters and what pain points still need solving in a market, and it lets us build a network of sharp people we can be useful to over time (intros, hiring, advisor roles).
- Personalize with ONE true, verifiable detail, and strongly prefer something from the LAST 12 MONTHS: a recent talk, panel, podcast, or conference appearance (speaking engagements are especially good), a recent announcement or news about ${c.company_name}, or a recent post. Then credit their perspective on how companies like theirs work with managed IT.
- VERIFY every specific claim with web search before using it. Only state a fact you can confirm from a citable source. If you cannot verify a recent, specific detail, do not invent one — open with an honest observation about their role or industry instead.
- Close with a soft ask: a few minutes to chat in the next week or two, and say plainly you are not selling anything.

Persona angle
- owner: keeping technology and security dependable as the business grows, without IT becoming a distraction.
- head_of_it: where managed services genuinely help versus where they just commoditize the work.
- other: a neutral version of the owner angle.

Length and channel
- email: keep it under about 130 words. Format as two or three SHORT paragraphs separated by a blank line: (1) "Hi ${c.full_name ? c.full_name.split(" ")[0] : "there"}," then a line or two on who you are and the approach, (2) one or two sentences of personalized relevance, (3) the ask. Sign off with "Thanks," then "${SENDER.name}" on their own lines. A short, specific subject line.
- linkedin: no subject (use null), 300 characters maximum, one line of relevance and one light ask.

Voice: direct, warm, conversational, a little humble. No em-dashes. No semicolons. No bullet points. No corporate filler. Reads as written by a person.

Honesty: never invent a detail, event, mutual connection, or claim. Plain and credible beats clever. Refer to the firm only as "Cohesium".

Return ONLY the structured object with a "drafts" array, one entry per channel.`;
}

// args may arrive as a parsed object or a JSON string depending on the runtime.
const A = typeof args === "string" ? JSON.parse(args) : args ?? {};
const contacts = (A.contacts ?? []).filter((c) => c && c.contact_id && c.channels?.length);

if (!contacts.length) {
  log("No contacts provided in args.contacts — nothing to do.");
  return { drafts: [] };
}

log(`Drafting for ${contacts.length} contact(s)…`);
phase("Draft");

const results = await pipeline(contacts, (c) =>
  agent(draftPrompt(c), {
    label: `draft:${c.full_name || c.contact_id}`,
    phase: "Draft",
    schema: DRAFT_SCHEMA,
  }).then((payload) => ({ contact_id: c.contact_id, drafts: payload?.drafts ?? [] })),
);

const drafts = results.filter(Boolean).flatMap((r) =>
  (r.drafts ?? []).map((d) => ({
    contact_id: r.contact_id,
    channel: d.channel,
    subject: d.subject ?? null,
    body: d.body,
  })),
);

return { drafts };
