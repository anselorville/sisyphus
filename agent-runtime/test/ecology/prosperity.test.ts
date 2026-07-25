import { describe, expect, it } from "vitest";

import { ProsperityScore } from "../../src/ecology/prosperity.js";
import type { ProsperitySignals } from "../../src/ecology/prosperity.js";

// Compile-time guarantee (enforced by `npm run check`, not just this file
// running as a test): ProsperitySignals must never gain a field that lets a
// model self-report its own performance. If any of these keys were ever
// added to the interface, `_NoSelfReportKeyOnProsperitySignals` would stop
// being `never` and this line would fail to typecheck.
type ForbiddenSelfReportKeys =
  | "confidence"
  | "selfRating"
  | "self_rating"
  | "selfAssessment"
  | "selfReported"
  | "modelConfidence"
  | "modelScore"
  | "llmConfidence";
type ExpectNever<T extends never> = T;
type _NoSelfReportKeyOnProsperitySignals = ExpectNever<Extract<keyof ProsperitySignals, ForbiddenSelfReportKeys>>;

function signals(overrides: Partial<ProsperitySignals> = {}): ProsperitySignals {
  return {
    taskSuccessRate: 0.9,
    userCorrectionRate: 0.05,
    responseTimeoutRate: 0.05,
    roleReuseRate: 0.7,
    verificationFailureRate: 0.05,
    ...overrides,
  };
}

describe("ProsperityScore.calculate -- fixed weighted formula (Step 3 mandated tests)", () => {
  const prosperity = new ProsperityScore();

  it("a run of user corrections lowers the score", () => {
    const fewCorrections = prosperity.calculate(signals({ userCorrectionRate: 0.0 }));
    const manyCorrections = prosperity.calculate(signals({ userCorrectionRate: 0.8 }));
    expect(manyCorrections).toBeLessThan(fewCorrections);
  });

  it("a run of passed verifications raises the score", () => {
    const manyVerificationFailures = prosperity.calculate(signals({ verificationFailureRate: 0.9 }));
    const manyVerificationPasses = prosperity.calculate(signals({ verificationFailureRate: 0.0 }));
    expect(manyVerificationPasses).toBeGreaterThan(manyVerificationFailures);
  });

  it("higher task success and role reuse raise the score", () => {
    const low = prosperity.calculate(signals({ taskSuccessRate: 0.1, roleReuseRate: 0.1 }));
    const high = prosperity.calculate(signals({ taskSuccessRate: 0.95, roleReuseRate: 0.95 }));
    expect(high).toBeGreaterThan(low);
  });

  it("a higher response timeout rate lowers the score", () => {
    const fewTimeouts = prosperity.calculate(signals({ responseTimeoutRate: 0.0 }));
    const manyTimeouts = prosperity.calculate(signals({ responseTimeoutRate: 0.9 }));
    expect(manyTimeouts).toBeLessThan(fewTimeouts);
  });

  it("computes the exact fixed 40/20/15/15/10 weighted formula", () => {
    const best = prosperity.calculate({
      taskSuccessRate: 1,
      userCorrectionRate: 0,
      responseTimeoutRate: 0,
      roleReuseRate: 1,
      verificationFailureRate: 0,
    });
    expect(best).toBeCloseTo(1, 10);

    const worst = prosperity.calculate({
      taskSuccessRate: 0,
      userCorrectionRate: 1,
      responseTimeoutRate: 1,
      roleReuseRate: 0,
      verificationFailureRate: 1,
    });
    expect(worst).toBeCloseTo(0, 10);

    // 0.4*0.8 + 0.2*(1-0.2) + 0.15*(1-0.1) + 0.15*0.6 + 0.1*(1-0.05)
    // = 0.32 + 0.16 + 0.135 + 0.09 + 0.095 = 0.8
    const mixed = prosperity.calculate({
      taskSuccessRate: 0.8,
      userCorrectionRate: 0.2,
      responseTimeoutRate: 0.1,
      roleReuseRate: 0.6,
      verificationFailureRate: 0.05,
    });
    expect(mixed).toBeCloseTo(0.8, 10);
  });

  it("clamps out-of-range rates instead of producing an out-of-bounds score", () => {
    const score = prosperity.calculate(
      signals({ taskSuccessRate: 1.5, userCorrectionRate: -1, responseTimeoutRate: 2, roleReuseRate: -0.5 }),
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("ProsperityScore -- never an LLM self-rating (Step 3 mandated test)", () => {
  it("only accepts objectively-observed rates, never a self-reported confidence/self-rating field", () => {
    const validSignals: ProsperitySignals = signals();

    // Runtime check: a valid ProsperitySignals object carries exactly the
    // five externally-observed rates -- nothing else, and specifically no
    // "confidence"/"selfRating" style field.
    expect(Object.keys(validSignals).sort()).toEqual(
      [
        "responseTimeoutRate",
        "roleReuseRate",
        "taskSuccessRate",
        "userCorrectionRate",
        "verificationFailureRate",
      ].sort(),
    );
  });
});
