import "server-only";
import { callModel, resolveProvider } from "../learning/provider";
import { whatWentWrong } from "./example-smooth-guard";

export { whatWentWrong } from "./example-smooth-guard";

// Tightening the prose of a worked example, without letting the model near the
// facts.
//
// The division of labour is the whole point. The operator supplies every
// concrete thing — who they write to, what they want to know, where they
// operate. The model may only make those words read better. It is explicitly
// not allowed to add a market, a place, a number, a company, or a claim,
// because the example sits directly above a rule forbidding invented specifics
// and would otherwise teach the opposite of what that rule says.
//
// That instruction is not trusted on its own. What comes back is checked
// against everything the operator supplied, and a rewrite that introduces
// content of its own is REJECTED — the un-smoothed version is returned instead.
// A promise in a system prompt is not a guarantee; this is.

const SYSTEM = `You tighten prose. You never add information.

You will be given a short outreach example. Improve only its rhythm and
readability: cut filler, fix awkward joins, keep sentences short.

Absolutely forbidden:
- Adding any specific that is not already present: no company names, places,
  numbers, dates, industries, job titles, or claims.
- Changing what the message is about, or who it is addressed to.
- Changing, removing or reordering any {{token}} — they are substituted later
  and must survive exactly as written, including the braces.
- Changing the labelled structure: the "Email —" and "LinkedIn —" markers, the
  Subject line, the greeting, the sign-off, and the blank lines between
  paragraphs all stay where they are.
- Adding a preamble or explanation.

Return the revised example as the "text" field.`;

// Structured output rather than raw text: the model cannot then wrap the
// example in a preamble or a code fence, which would otherwise become part of
// the prompt the drafter reads.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;

export type SmoothResult = {
  text: string;
  /** Did the model's version survive the check, or was it discarded? */
  smoothed: boolean;
  note?: string;
};

/**
 * Tighten one example, falling back to the original whenever anything is off.
 *
 * Never throws and never blocks: with no provider configured, a refusal, a
 * network failure, or a rewrite that smuggled in a fact, the operator simply
 * gets the deterministic version they would have had anyway.
 */
export async function smoothExample(
  example: string,
  permitted: string,
): Promise<SmoothResult> {
  const provider = resolveProvider();
  if (!provider) {
    return { text: example, smoothed: false, note: "No model configured — using the plain version." };
  }

  let candidate: string;
  try {
    const response = await callModel(provider, {
      system: SYSTEM,
      user: example,
      schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "smoothed_example",
      maxTokens: 1200,
    });
    if (response.refused) {
      return { text: example, smoothed: false, note: "The model declined; using the plain version." };
    }
    const parsed = JSON.parse(
      response.text.trim().replace(/^```(?:\w+)?\s*/i, "").replace(/```$/, "").trim(),
    ) as { text?: unknown };
    if (typeof parsed.text !== "string" || !parsed.text.trim()) {
      return { text: example, smoothed: false, note: "The model returned nothing usable." };
    }
    candidate = parsed.text.trim();
  } catch (e) {
    return {
      text: example,
      smoothed: false,
      note: `Could not reach the model (${e instanceof Error ? e.message : "unknown"}); using the plain version.`,
    };
  }

  const problem = whatWentWrong(example, candidate, permitted);
  if (problem) {
    return { text: example, smoothed: false, note: `Rewrite discarded: ${problem}` };
  }
  return { text: candidate, smoothed: true };
}
