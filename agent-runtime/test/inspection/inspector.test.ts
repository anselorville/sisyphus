import { describe, expect, it } from "vitest";

import { Inspector } from "../../src/inspection/inspector.js";
import type { Evidence, InspectionTask } from "../../src/inspection/inspector.js";

function codeTask(overrides: Partial<InspectionTask> = {}): InspectionTask {
  return {
    taskId: "task-1",
    kind: "code",
    goal: "add a failing test, then make it pass",
    claimedStatus: "completed",
    ...overrides,
  };
}

describe("Inspector.verify (Step 1 mandated test)", () => {
  it("does not mark a code task successful without command evidence", async () => {
    const inspector = new Inspector();
    const result = await inspector.verify(codeTask(), []);
    expect(result.status).toBe("unverified");
  });
});

describe("Inspector.verify -- fuller evidence coverage", () => {
  const inspector = new Inspector({ now: () => new Date("2026-01-01T00:00:00.000Z") });

  it("verifies a code task with real command evidence showing success", async () => {
    const evidence: Evidence[] = [{ kind: "command_output", outcome: "success", detail: "npm test exited 0", exitCode: 0 }];
    const result = await inspector.verify(codeTask(), evidence);
    expect(result.status).toBe("verified");
  });

  it("does not verify a code task as passed when a command failed, even though the task claims success", async () => {
    const evidence: Evidence[] = [{ kind: "command_output", outcome: "failure", detail: "npm test exited 1", exitCode: 1 }];
    const result = await inspector.verify(codeTask({ claimedStatus: "completed" }), evidence);
    expect(result.status).not.toBe("verified");
    expect(result.status).toBe("failed");
  });

  it("treats a bare tool_result as insufficient for a code task -- command/test evidence is required", async () => {
    const evidence: Evidence[] = [{ kind: "tool_result", outcome: "success", detail: "read the file" }];
    const result = await inspector.verify(codeTask(), evidence);
    expect(result.status).toBe("unverified");
  });

  it("verifies a non-code task from a plain successful tool_result", async () => {
    const mailTask: InspectionTask = {
      taskId: "task-2",
      kind: "mail",
      goal: "send the status update",
      claimedStatus: "completed",
    };
    const evidence: Evidence[] = [{ kind: "tool_result", outcome: "success", detail: "mail_send returned a message id" }];
    const result = await inspector.verify(mailTask, evidence);
    expect(result.status).toBe("verified");
  });

  it("distinguishes unverified ('we don't know') from failed ('we know it failed')", async () => {
    const unknown = await inspector.verify(codeTask(), []);
    const known = await inspector.verify(codeTask(), [
      { kind: "command_output", outcome: "failure", detail: "build failed", exitCode: 1 },
    ]);
    expect(unknown.status).toBe("unverified");
    expect(known.status).toBe("failed");
    expect(unknown.status).not.toBe(known.status);
  });

  it("a failing test_output evidence item also blocks a verified verdict, even alongside a passing command", async () => {
    const evidence: Evidence[] = [
      { kind: "command_output", outcome: "success", detail: "build exited 0", exitCode: 0 },
      { kind: "test_output", outcome: "failure", detail: "3 tests failed", exitCode: 1 },
    ];
    const result = await inspector.verify(codeTask(), evidence);
    expect(result.status).toBe("failed");
  });

  it("returns a frozen result and reports how much evidence it considered, using the injected clock", async () => {
    const evidence: Evidence[] = [
      { kind: "command_output", outcome: "success", detail: "ok", exitCode: 0 },
      { kind: "tool_result", outcome: "success", detail: "extra corroborating evidence" },
    ];
    const result = await inspector.verify(codeTask(), evidence);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.evidenceConsidered).toBe(2);
    expect(result.verifiedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("Inspector boundary: read-only, never executes anything itself", () => {
  it("has no tool-execution surface of its own", () => {
    const inspector = new Inspector();
    expect("execute" in inspector).toBe(false);
    expect("run" in inspector).toBe(false);
    expect("tools" in inspector).toBe(false);
  });
});
