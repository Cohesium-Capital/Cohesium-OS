import { describe, it, expect } from "vitest";
import {
  recordErrorRate,
  resolveGate,
  fnv1a,
  isSampled,
  rollingErrorRate,
  shouldEscalate,
  recordHasError,
} from "./math";

describe("recordErrorRate", () => {
  it("is 0 when nothing graded", () => {
    expect(recordErrorRate(0, 0)).toBe(0);
  });
  it("divides errors by graded", () => {
    expect(recordErrorRate(3, 12)).toBe(0.25);
  });
});

describe("resolveGate", () => {
  const base = { minSampleSize: 20, threshold: 0.2 };

  it("is open with no sample", () => {
    expect(resolveGate({ ...base, gradedCount: 0, errorCount: 0, sampleSize: 0 })).toBe("open");
  });

  it("passes once enough graded and under threshold", () => {
    // 20 graded, 2 errors = 10% < 20%, sample fully graded
    expect(resolveGate({ ...base, gradedCount: 20, errorCount: 2, sampleSize: 20 })).toBe("passed");
  });

  it("stays open before reaching the required sample", () => {
    expect(resolveGate({ ...base, gradedCount: 5, errorCount: 0, sampleSize: 20 })).toBe("open");
  });

  it("fails fast when the best achievable rate is already at/over threshold", () => {
    // 4 errors out of a 20-sample = 20% even if the rest grade clean → failed
    expect(resolveGate({ ...base, gradedCount: 5, errorCount: 4, sampleSize: 20 })).toBe("failed");
  });

  it("uses min(minSampleSize, sampleSize) as the required count", () => {
    // sample of 8, minSampleSize 20 → required 8; 1 error of 8 graded = 12.5% < 20%
    expect(resolveGate({ ...base, gradedCount: 8, errorCount: 1, sampleSize: 8 })).toBe("passed");
  });
});

describe("isSampled / fnv1a", () => {
  it("fnv1a is deterministic", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
  });
  it("samples everything at rate >= 1", () => {
    expect(isSampled("any-id", 1)).toBe(true);
  });
  it("samples nothing at rate <= 0", () => {
    expect(isSampled("any-id", 0)).toBe(false);
  });
  it("is stable for the same id+rate", () => {
    const a = isSampled("contact-123", 0.5);
    const b = isSampled("contact-123", 0.5);
    expect(a).toBe(b);
  });
  it("roughly honors the rate across many ids", () => {
    let n = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (isSampled(`id-${i}`, 0.3)) n++;
    expect(n / N).toBeGreaterThan(0.25);
    expect(n / N).toBeLessThan(0.35);
  });
});

describe("rollingErrorRate", () => {
  it("0 on empty", () => expect(rollingErrorRate([])).toBe(0));
  it("windows to the most recent N", () => {
    const arr = [true, true, false, false]; // last 2 = false,false
    expect(rollingErrorRate(arr, 2)).toBe(0);
    expect(rollingErrorRate(arr, 4)).toBe(0.5);
  });
});

describe("shouldEscalate", () => {
  it("escalates when rolling rate exceeds threshold and sampling < 1", () => {
    expect(shouldEscalate({ rollingRate: 0.3, threshold: 0.2, sampleRate: 0.5, autoEscalate: true })).toBe(true);
  });
  it("does not escalate at full sampling", () => {
    expect(shouldEscalate({ rollingRate: 0.3, threshold: 0.2, sampleRate: 1, autoEscalate: true })).toBe(false);
  });
  it("respects the autoEscalate switch", () => {
    expect(shouldEscalate({ rollingRate: 0.3, threshold: 0.2, sampleRate: 0.5, autoEscalate: false })).toBe(false);
  });
});

describe("recordHasError", () => {
  it("true if any verdict wrong/missing", () => {
    expect(recordHasError(["correct", "wrong"])).toBe(true);
    expect(recordHasError(["correct", "missing"])).toBe(true);
  });
  it("false if all correct", () => {
    expect(recordHasError(["correct", "correct"])).toBe(false);
  });
});
