import { renderCopy, DEFAULT_COPY, type DraftCopy, type WorkspaceProfile } from "../workspace/identity";

// Building a firm's worked examples from a short interview.
//
// The alternative was to have a model generate examples from the workspace
// profile. That was rejected on the grounds that it would have to INVENT a
// market specific to be vivid — and the example sits directly above a rule
// saying never invent a specific, so it would teach by counter-example. It
// would also pull toward the median of what a model thinks outreach sounds
// like, which is marketing email, the exact register the prompt spends forty
// lines banning.
//
// So substance comes from the operator, always. Three questions, answered in
// their own words, slotted into the skeleton that is already known to work. A
// model may afterwards tighten the PROSE (see example-smooth.ts), and what it
// returns is checked for smuggled-in facts before it is accepted.

export type ExampleAnswers = {
  /** Who a typical recipient is: "growing pediatric practices". */
  recipients: string;
  /** What you actually want to know: "where it helps and where it just adds overhead". */
  curiosity: string;
  /** What operators in this market talk about — the msp-track equivalent. */
  operatorTopics?: string;
  /** Optional scope: "the mid-Atlantic". */
  region?: string;
};

/** Wrap to the width the surrounding prompt text uses, so it reads as one document. */
export function wrap(text: string, width = 78, indent = ""): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length + indent.length > width && line) {
      lines.push(indent + line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}

const clean = (s: string | undefined): string => (s ?? "").trim().replace(/\s+/g, " ");

/** Strip a leading connective so answers read naturally mid-sentence. */
const asClause = (s: string): string =>
  clean(s).replace(/^(about|on|whether|how|where|what|why)\s+/i, (m) => m.toLowerCase());

/**
 * Assemble both tracks' worked examples from the answers.
 *
 * Deterministic and offline — the same answers always produce the same text, so
 * an operator can see exactly what their words became before anything is saved,
 * and re-running changes nothing unexpectedly.
 */
export function buildExamples(answers: ExampleAnswers): Pick<DraftCopy, "goldCustomer" | "goldMsp"> {
  const recipients = clean(answers.recipients) || "companies like yours";
  const curiosity = asClause(answers.curiosity) || "where it helps and where it just adds overhead";
  const topics =
    asClause(answers.operatorTopics ?? "") ||
    "where the market is heading, what's getting harder, what still makes the model work";
  const region = clean(answers.region);
  const inRegion = region ? ` in ${region}` : "";

  const goldCustomer = [
    "Gold examples (imitate this voice and shape, never copy the facts)",
    "",
    "Email —",
    "Subject: quick question on your {{marketShort}} setup",
    "",
    "Hi Trish,",
    "",
    wrap(
      `I've been digging into how ${recipients} actually work with their {{providerGeneric}}s, ${curiosity}, and figured someone in your seat would have a clear read on it.`,
    ),
    "",
    "{{senderIntro}}. {{approachInline}}",
    "",
    wrap(
      "Any chance you'd have a few minutes in the next week or two? I'm not selling anything, just trying to understand the space.",
    ),
    "",
    "Thanks,",
    "{{senderName}}",
    "",
    "LinkedIn —",
    wrap(
      `Hi Jim, {{senderIntro}} researching how ${recipients} work with their {{providerGeneric}}s, and your read from the inside would be useful. Open to a quick chat in the next week or two? Not selling anything.`,
    ),
  ].join("\n");

  const goldMsp = [
    "Gold examples (imitate this voice and shape, never copy the facts)",
    "",
    "Email —",
    "Subject: your take on the {{market}}",
    "",
    "Hi Tom,",
    "",
    wrap(
      `I've been talking with people who've built {{providerPlural}}${inRegion} about ${topics}, and figured a founder in your seat would have a clear read on it.`,
    ),
    "",
    "{{senderIntro}}. {{approachInline}}",
    "",
    wrap(
      "Any chance you'd have a few minutes in the next week or two? I'm not selling anything, just trying to understand the business from the operator's side.",
    ),
    "",
    "Thanks,",
    "{{senderName}}",
    "",
    "LinkedIn —",
    wrap(
      `Hi Sam, {{senderIntro}} researching the {{market}} from the operator's side, and your read on where things are heading for {{providerAbbrevPlural}} would be useful. Open to a quick chat? Not selling anything.`,
    ),
  ].join("\n");

  return { goldCustomer, goldMsp };
}

/**
 * Everything the operator supplied, as one corpus.
 *
 * Used to check that a smoothing pass added no substance of its own — the
 * answers, plus the skeleton it is allowed to keep, are the complete set of
 * things a rewrite may legitimately contain.
 */
export function permittedSource(answers: ExampleAnswers, profile: WorkspaceProfile): string {
  return [
    answers.recipients,
    answers.curiosity,
    answers.operatorTopics ?? "",
    answers.region ?? "",
    profile.firmName,
    profile.senderName,
    profile.senderIntro,
    profile.approach,
    ...Object.values(profile.vocab),
    renderCopy(DEFAULT_COPY.goldCustomer, profile),
    renderCopy(DEFAULT_COPY.goldMsp, profile),
  ].join(" ");
}
