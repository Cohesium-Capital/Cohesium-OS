import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time shared-secret comparison for webhook/cron tokens.
 *
 * Hashing both sides first makes the buffers equal-length, so timingSafeEqual
 * is applicable regardless of input sizes and nothing about the expected
 * secret's length leaks. Fails closed when the expected secret is unset.
 */
export function secretMatches(given: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(given ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
