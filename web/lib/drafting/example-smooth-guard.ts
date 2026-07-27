// The checks a smoothed example has to survive.
//
// Split from example-smooth.ts so it is testable: that module carries the
// "server-only" guard because it calls the model, and the test runner cannot
// resolve it. This half touches nothing but strings, which is the half worth
// pinning — it is what makes "the model may not add facts" enforced rather
// than merely instructed.

/** The checks a rewrite has to pass, or null when it is clean. */
export function whatWentWrong(
  original: string,
  candidate: string,
  permitted: string,
): string | null {
  if (candidate.length < original.length * 0.5) {
    return "it cut the example in half or more";
  }

  // Tokens are substituted downstream; losing one silently blanks a sentence.
  const tokensOf = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(",");
  if (tokensOf(candidate) !== tokensOf(original)) {
    return "it altered the {{tokens}}";
  }

  for (const marker of ["Email —", "LinkedIn —", "Subject:"]) {
    if (original.includes(marker) && !candidate.includes(marker)) {
      return `it dropped the "${marker}" structure`;
    }
  }

  // The substance check.
  //
  // Phrase matching was the obvious approach and it is wrong: deleting words —
  // exactly what tightening does — joins two surviving words into a pair that
  // never appeared in the source, so a legitimate edit reads as invention.
  //
  // What actually needs policing is narrower and easier to see: SPECIFICS. The
  // dangerous rewrite adds a place, a company, a number, a date. Those are
  // proper nouns and numerals, and no amount of deletion can conjure one.
  const permittedWords = wordSet(`${original} ${permitted}`);

  const newSpecifics = specifics(candidate).filter((w) => !permittedWords.has(w.toLowerCase()));
  if (newSpecifics.length) {
    return `it introduced specifics of its own (${newSpecifics
      .slice(0, 3)
      .map((w) => `"${w}"`)
      .join(", ")})`;
  }

  // Backstop for invented material that carries no proper noun — a fluent
  // lowercase clause about nothing. Tightening removes words; it does not need
  // a vocabulary of its own, so a handful of new content words is tolerable and
  // a flood is not.
  const newContent = [...wordSet(candidate)].filter(
    (w) => !permittedWords.has(w) && w.length > 3 && !STOPWORDS.has(w),
  );
  if (newContent.length > 6) {
    return `it added material rather than tightening (${newContent.length} new words)`;
  }

  return null;
}

const STOPWORDS = new Set([
  "that", "this", "have", "been", "with", "your", "their", "they", "them",
  "from", "about", "would", "could", "what", "where", "when", "just", "also",
  "than", "then", "into", "over", "some", "much", "more", "most", "very",
]);

/** Words a rewrite cannot invent by deletion: proper nouns and numbers. */
function specifics(text: string): string[] {
  const out = new Set<string>();
  // Skip {{tokens}} — they are placeholders, not content.
  const stripped = text.replace(/\{\{\w+\}\}/g, " ");
  // Split into sentences so a sentence-initial capital is not read as a name.
  //
  // Newlines are NOT boundaries: the example is hard-wrapped, so treating them
  // as sentence starts made every word at the head of a wrapped line invisible
  // to this check — which is exactly where an inserted place name tends to land.
  for (const sentence of stripped.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (!w) return;
      if (/\d/.test(w)) out.add(w);
      // Capitalised, but not the first word of the sentence.
      else if (i > 0 && /^[A-Z][a-z]{2,}$/.test(w)) out.add(w);
    });
  }
  return [...out];
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\{\{\w+\}\}/g, " ")
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}
