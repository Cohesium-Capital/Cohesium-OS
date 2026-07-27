import { renderCopy, DEFAULT_COPY, type WorkspaceProfile } from "../workspace/identity";

// Did a draft copy the worked example instead of imitating it?
//
// The gold examples exist to teach voice and shape, and the prompt says
// "imitate this voice and shape, never copy the facts". Across 334 real drafts
// that instruction held — every apparent match ("pediatric practices",
// "mid-Atlantic", even the recipient names Trish and Tom) turned out to be
// genuinely true of that contact. So this is not a fix for a known failure.
//
// It exists because that check was a one-off SQL query I ran by hand, and the
// property it verified is one that can silently stop holding: a prompt edit, a
// model change, or a workspace pasting in a badly-written example. A distinctive
// phrase from the example appearing in a draft where the CONTACT'S OWN DATA
// cannot explain it is the signal, and it costs almost nothing to watch for.
//
// Deliberately advisory. It reports; it never rejects. A false positive that
// blocked a good draft would be worse than the thing it is guarding against.

/** Phrases that are markers of the example rather than of English. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "have", "has", "been", "was",
  "are", "you", "your", "our", "their", "they", "them", "from", "about",
  "would", "could", "what", "where", "when", "how", "who", "i've", "i'm",
  "not", "just", "any", "few", "next", "week", "two", "open", "quick", "chat",
  "hi", "thanks", "email", "linkedin", "subject", "selling", "anything",
]);

const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();

/**
 * Distinctive n-grams of an example: runs of consecutive words that are not all
 * filler. Length 4 because shorter runs catch ordinary phrasing ("I've been
 * talking with") that the prompt actively WANTS imitated, while longer runs
 * miss a lifted noun phrase.
 */
export function distinctivePhrases(text: string, n = 4): string[] {
  const words = normalise(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    const run = words.slice(i, i + n);
    // At least two content words, or it is a phrase about nothing.
    if (run.filter((w) => !STOPWORDS.has(w)).length >= 2) out.add(run.join(" "));
  }
  return [...out];
}

export type LeakFinding = {
  phrase: string;
  /** The example the phrase came from, for the operator's message. */
  source: "gold" | "persona";
};

/**
 * Precompute the phrases worth watching for, once per batch.
 *
 * The example and the baseline are the same for every draft in a run, so
 * deriving them per draft was pure repeated work — four renders and four
 * n-gram passes over ~700 characters, multiplied by the batch size. Hoisting
 * them out makes a fifty-draft ingest do that work once.
 */
export function exampleLeakDetector(
  profile: WorkspaceProfile,
  track: "customer" | "msp" = "customer",
): (draftBody: string, contactContext: string) => LeakFinding[] {
  const customer = track === "customer";

  // The subtlety this whole function turns on: MOST of a worked example is
  // meant to be reused. "I've been digging into how", "I'm a cofounder of
  // <firm>", "any chance you'd have a few minutes" — the prompt explicitly asks
  // the model to imitate that voice, and the sender's intro line is prescribed
  // verbatim by the rules. Flagging those would flag every good draft.
  //
  // What must NOT be reused is the example's MARKET SUBSTANCE. The neutral
  // default is exactly the example with that substance removed, so using it as
  // a baseline isolates the difference: whatever a workspace's example says
  // that the neutral skeleton does not is, by construction, its market content.
  //
  // A workspace still on the default therefore has nothing to leak, which is
  // correct — that is the point of the default being neutral.
  const baseline = new Set([
    ...distinctivePhrases(
      renderCopy(customer ? DEFAULT_COPY.goldCustomer : DEFAULT_COPY.goldMsp, profile),
    ),
    ...distinctivePhrases(
      renderCopy(
        customer ? DEFAULT_COPY.personaAnglesCustomer : DEFAULT_COPY.personaAnglesMsp,
        profile,
      ),
    ),
  ]);

  const sources: [LeakFinding["source"], string][] = [
    ["gold", renderCopy(customer ? profile.copy.goldCustomer : profile.copy.goldMsp, profile)],
    [
      "persona",
      renderCopy(
        customer ? profile.copy.personaAnglesCustomer : profile.copy.personaAnglesMsp,
        profile,
      ),
    ],
  ];

  // Phrases unique to THIS workspace's examples, deduped across both sources.
  const watch: LeakFinding[] = [];
  const seen = new Set<string>();
  for (const [source, text] of sources) {
    for (const phrase of distinctivePhrases(text)) {
      if (seen.has(phrase) || baseline.has(phrase)) continue;
      seen.add(phrase);
      watch.push({ phrase, source });
    }
  }

  return (draftBody: string, contactContext: string) => {
    const draft = normalise(draftBody);
    const context = normalise(contactContext);
    // In the draft, and NOT explained by anything true about this contact.
    return watch.filter((w) => draft.includes(w.phrase) && !context.includes(w.phrase));
  };
}

/** One-off convenience wrapper; prefer the detector when checking a batch. */
export function findExampleLeaks(
  draftBody: string,
  profile: WorkspaceProfile,
  contactContext: string,
  track: "customer" | "msp" = "customer",
): LeakFinding[] {
  return exampleLeakDetector(profile, track)(draftBody, contactContext);
}

/** One operator-facing line, or null when there is nothing to say. */
export function describeLeaks(findings: LeakFinding[]): string | null {
  if (!findings.length) return null;
  const shown = findings.slice(0, 3).map((f) => `"${f.phrase}"`).join(", ");
  const more = findings.length > 3 ? ` (+${findings.length - 3} more)` : "";
  return (
    `${findings.length} draft phrase(s) came from the worked example rather than from this contact: ${shown}${more}. ` +
    `Worth a read before sending — the example is meant to model voice, not supply facts.`
  );
}
