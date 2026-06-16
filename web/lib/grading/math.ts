// Error-rate math, gating, and sampling. Pure functions — unit tested.
// Ported from Gradebook (lib/grading/math.ts), unchanged logic. The gate is what
// lets a batch advance (enrich/draft/send) only once a graded sample clears the
// module's record-level error-rate threshold.

export type GateStatus = "open" | "passed" | "failed";

export interface GateInput {
  /** sampled records that have been fully graded (finalized) */
  gradedCount: number;
  /** graded records with ≥1 field 'wrong' or 'missing' (or rejected outright) */
  errorCount: number;
  /** total sampled records in the batch */
  sampleSize: number;
  /** settings.min_sample_size (default 20) */
  minSampleSize: number;
  /** module gate threshold, e.g. 0.20 */
  threshold: number;
}

/** Record-level error rate: records with ≥1 wrong/missing field ÷ graded records. */
export function recordErrorRate(errorCount: number, gradedCount: number): number {
  if (gradedCount === 0) return 0;
  return errorCount / gradedCount;
}

/**
 * Gate logic:
 * - passed: graded ≥ min(minSampleSize, sampleSize) AND error rate < threshold
 * - failed (fail-fast): even if every remaining sample grades clean, the final
 *   rate (errorCount / sampleSize) cannot fall below threshold
 * - otherwise open
 */
export function resolveGate(input: GateInput): GateStatus {
  const { gradedCount, errorCount, sampleSize, minSampleSize, threshold } = input;
  if (sampleSize === 0) return "open";

  // Fail fast: best achievable final error rate already at/over threshold.
  if (errorCount / sampleSize >= threshold) return "failed";

  const required = Math.min(minSampleSize, sampleSize);
  if (gradedCount >= required && recordErrorRate(errorCount, gradedCount) < threshold) {
    return "passed";
  }
  return "open";
}

/**
 * Deterministic sampling: hash(contact_id) mod 100 < sampleRate × 100.
 * FNV-1a 32-bit keeps re-runs comparable across processes.
 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function isSampled(contactId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return fnv1a(contactId) % 100 < Math.round(sampleRate * 100);
}

/** Rolling record-level error rate over the most recent graded records. */
export function rollingErrorRate(recentHasError: boolean[], window = 50): number {
  const slice = recentHasError.slice(-window);
  if (slice.length === 0) return 0;
  return slice.filter(Boolean).length / slice.length;
}

/**
 * Auto-escalation: rolling rate (last 50) exceeds threshold while sampling < 100%.
 * Ratchet up to 1.0; manual ratchet-down only.
 */
export function shouldEscalate(opts: {
  rollingRate: number;
  threshold: number;
  sampleRate: number;
  autoEscalate: boolean;
}): boolean {
  return (
    opts.autoEscalate && opts.sampleRate < 1.0 && opts.rollingRate > opts.threshold
  );
}

/** A record counts as an error if any field verdict is wrong/missing. */
export function recordHasError(verdicts: string[]): boolean {
  return verdicts.some((v) => v === "wrong" || v === "missing");
}
