// What counts as one independent judgment.
//
// The activation gate exists to stop a single frame of mind becoming doctrine:
// someone reacting to one weird batch, or tired at the end of a session, makes
// several corrections that all reflect that moment rather than a durable
// preference. So a rule wants evidence from more than one occasion.
//
// The unit for "occasion" matters, and the obvious candidates are both wrong:
//
//   calendar days   punishes sparse use. A founder who does all their review in
//                   one Saturday block every fortnight never accumulates two
//                   days, so nothing they teach ever lands — while 11:58pm and
//                   12:04am count as two days despite being one sitting.
//   runs            too fine. Three sourcing runs in one afternoon are three
//                   runs and one frame of mind.
//
// A session — corrections clustered together, separated from the next cluster
// by an idle gap — is what actually means "a separate occasion of attention".
// Real usage bears this out: the corrections in this database fall into two
// blocks, 10 within 4.5 minutes and 4 within 76 seconds, two days apart. Gaps
// inside a block are seconds; the gap between them is days. Any threshold in
// between separates them correctly.

/** Idle gap that ends a session. Well above a coffee break, well below "later". */
export const SESSION_GAP_HOURS = 4;

export type Occasion = { occurred_at: string; ref_id?: string };

/**
 * Number of distinct working sessions the given corrections span. Sorted by
 * time, then split wherever the gap to the previous correction exceeds the
 * threshold.
 */
export function countSessions(items: Occasion[]): number {
  if (!items.length) return 0;
  const times = items
    .map((i) => new Date(i.occurred_at).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (!times.length) return 0;

  const gapMs = SESSION_GAP_HOURS * 60 * 60 * 1000;
  let sessions = 1;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > gapMs) sessions += 1;
  }
  return sessions;
}

/**
 * Support required to activate a rule from a SINGLE session.
 *
 * A pattern that repeats many times inside one sitting is not a mood — it is a
 * systematic flaw showing up on record after record, which is exactly what the
 * prompt should learn. Requiring two sessions unconditionally would throw that
 * away, and would leave anyone who works in occasional concentrated blocks
 * unable to teach the system at all.
 *
 * The higher bar is what keeps it honest: six corrections on six different
 * records, all pointing the same way, is a much stronger claim than three.
 */
export const SINGLE_SESSION_SUPPORT = 6;

export type SpreadVerdict = {
  ok: boolean;
  sessions: number;
  distinctRecords: number;
  reason: string;
};

/**
 * Does this evidence represent more than one opinion?
 *
 * Either it spans two sessions with the normal support level, or it is one
 * session making the same point on enough separate records that a mood is not a
 * plausible explanation.
 */
export function evidenceIsIndependent(
  evidence: Occasion[],
  normalSupport: number,
): SpreadVerdict {
  const sessions = countSessions(evidence);
  const distinctRecords = new Set(
    evidence.map((e) => e.ref_id ?? e.occurred_at),
  ).size;

  if (sessions >= 2 && evidence.length >= normalSupport) {
    return {
      ok: true,
      sessions,
      distinctRecords,
      reason: `${evidence.length} corrections across ${sessions} separate sessions`,
    };
  }

  if (
    sessions === 1 &&
    evidence.length >= SINGLE_SESSION_SUPPORT &&
    distinctRecords >= SINGLE_SESSION_SUPPORT
  ) {
    return {
      ok: true,
      sessions,
      distinctRecords,
      reason: `${evidence.length} corrections on ${distinctRecords} separate records in one session`,
    };
  }

  return {
    ok: false,
    sessions,
    distinctRecords,
    reason:
      sessions >= 2
        ? `only ${evidence.length} corrections (needs ${normalSupport})`
        : `one session, ${evidence.length} correction(s) on ${distinctRecords} record(s) — needs ${SINGLE_SESSION_SUPPORT} on separate records, or a second session`,
  };
}
