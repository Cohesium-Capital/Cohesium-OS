import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recordErrorRate,
  resolveGate,
  fnv1a,
  isSampled,
  rollingErrorRate,
  shouldEscalate,
  recordHasError,
} from "./math";

// Pure-function unit tests on Node's built-in test runner (no vitest/rollup).
// Run with: npm run test  ->  node --import tsx --test lib/**/*.test.ts

describe("recordErrorRate", () => {
  it("is 0 when nothing graded", () => {
    assert.equal(recordErrorRate(0, 0), 0);
  });
  it("divides errors by graded", () => {
    assert.equal(recordErrorRate(3, 12), 0.25);
  });
});

describe("resolveGate", () => {
  const base = { minSampleSize: 20, threshold: 0.2 };

  it("is open with no sample", () => {
    assert.equal(resolveGate({ ...base, gradedCount: 0, errorCount: 0, sampleSize: 0 }), "open");
  });

  it("passes once enough graded and under threshold", () => {
    assert.equal(resolveGate({ ...base, gradedCount: 20, errorCount: 2, sampleSize: 20 }), "passed");
  });

  it("stays open before reaching the required sample", () => {
    assert.equal(resolveGate({ ...base, gradedCount: 5, errorCount: 0, sampleSize: 20 }), "open");
  });

  it("fails fast when the best achievable rate is already at/over threshold", () => {
    assert.equal(resolveGate({ ...base, gradedCount: 5, errorCount: 4, sampleSize: 20 }), "failed");
  });

  it("uses min(minSampleSize, sampleSize) as the required count", () => {
    assert.equal(resolveGate({ ...base, gradedCount: 8, errorCount: 1, sampleSize: 8 }), "passed");
  });
});

describe("isSampled / fnv1a", () => {
  it("fnv1a is deterministic", () => {
    assert.equal(fnv1a("abc"), fnv1a("abc"));
    assert.notEqual(fnv1a("abc"), fnv1a("abd"));
  });
  it("samples everything at rate >= 1", () => {
    assert.equal(isSampled("any-id", 1), true);
  });
  it("samples nothing at rate <= 0", () => {
    assert.equal(isSampled("any-id", 0), false);
  });
  it("is stable for the same id+rate", () => {
    assert.equal(isSampled("contact-123", 0.5), isSampled("contact-123", 0.5));
  });
  it("roughly honors the rate across many ids", () => {
    let n = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (isSampled(`id-${i}`, 0.3)) n++;
    assert.ok(n / N > 0.25, `expected >0.25, got ${n / N}`);
    assert.ok(n / N < 0.35, `expected <0.35, got ${n / N}`);
  });
});

describe("rollingErrorRate", () => {
  it("0 on empty", () => assert.equal(rollingErrorRate([]), 0));
  it("windows to the most recent N", () => {
    const arr = [true, true, false, false];
    assert.equal(rollingErrorRate(arr, 2), 0);
    assert.equal(rollingErrorRate(arr, 4), 0.5);
  });
});

describe("shouldEscalate", () => {
  it("escalates when rolling rate exceeds threshold and sampling < 1", () => {
    assert.equal(shouldEscalate({ rollingRate: 0.3, threshold: 0.2, sampleRate: 0.5, autoEscalate: true }), true);
  });
  it("does not escalate at full sampling", () => {
    assert.equal(shouldEscalate({ rollingRate: 0.3, threshold: 0.2, sampleRate: 1, autoEscalate: true }), false);
  });
  it("respects the autoEscalate switch", () => {
    assert.equal(shouldEscalate({ rollingRate: 0.3, threshold: 0.2, sampleRate: 0.5, autoEscalate: false }), false);
  });
});

describe("recordHasError", () => {
  it("true if any verdict wrong/missing", () => {
    assert.equal(recordHasError(["correct", "wrong"]), true);
    assert.equal(recordHasError(["correct", "missing"]), true);
  });
  it("false if all correct", () => {
    assert.equal(recordHasError(["correct", "correct"]), false);
  });
});
