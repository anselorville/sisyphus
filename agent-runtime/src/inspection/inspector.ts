/**
 * Inspector: read-only verification of a task's claimed outcome against the
 * evidence it actually produced -- design doc section 6.3 (first-generation
 * roles: "Inspector 只读验证任务结果、测试输出和外部影响") and this task's
 * own Global Constraint that a task must never be marked successful on the
 * inspecting role's say-so alone.
 *
 * verify() is deterministic and evidence-driven, exactly like
 * ProsperityScore.calculate()/Queen.evaluate() elsewhere in this package: it
 * never calls a model and never takes `task.claimedStatus` at face value --
 * only the structured Evidence actually supplied moves the verdict. This
 * class is the judgment layer underneath the Inspector *role* (see
 * ../roles/manifests.ts's INSPECTOR_ROLE_MANIFEST and
 * resources/roles/inspector.md): whatever an Inspector Pi Session reads or
 * observes must be reduced to structured Evidence before it reaches here.
 * This module itself never executes a tool and never reads anything on its
 * own -- it has no "execute"/"run" surface at all (see
 * test/inspection/inspector.test.ts's boundary test), matching the design
 * doc's "只读" (read-only) framing taken to its logical conclusion: it
 * doesn't even read, it only judges what has already been collected.
 *
 * VerificationStatus has three values, not two, on purpose: "unverified"
 * (no adequate evidence either way -- the honest "we don't know") is always
 * distinguishable from "failed" (evidence directly contradicts success).
 * Only "verified" ever counts as a real success signal for
 * ProsperityScore/PheromoneMap -- see ../ecology/prosperity.ts's
 * verificationFailureRate, which "unverified" alone must never feed as
 * though it were an observed failure.
 */

export type InspectionTaskKind = "code" | "mail" | "web" | "device" | "generic";

/** What the executing role itself claims about the task it just ran -- Inspector treats this as a claim to check, never as a fact (see the module doc comment). */
export type ClaimedTaskStatus = "completed" | "failed";

export interface InspectionTask {
  readonly taskId: string;
  readonly kind: InspectionTaskKind;
  readonly goal: string;
  readonly claimedStatus: ClaimedTaskStatus;
}

export type EvidenceKind = "command_output" | "test_output" | "tool_result" | "external_check";

/** One directly-observed fact about what actually happened -- never the inspecting role's own opinion or reasoning about it (see the Global Constraint on never persisting chain-of-thought; `detail` must always be a short factual description, not reasoning). */
export interface Evidence {
  readonly kind: EvidenceKind;
  readonly outcome: "success" | "failure";
  /** Short, human-reviewable description of what was observed (e.g. "npm test exited 0", "GET /health -> 200"). */
  readonly detail: string;
  /** Present for command_output/test_output evidence -- the actual observed exit code. */
  readonly exitCode?: number;
}

export const VERIFICATION_STATUSES = ["verified", "failed", "unverified"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface VerificationResult {
  readonly status: VerificationStatus;
  /** Short, structured reason for the verdict -- always traceable to specific evidence (or its absence), never free-form justification or a reasoning trace. */
  readonly reason: string;
  readonly evidenceConsidered: number;
  readonly verifiedAt: string;
}

/** Task kinds whose evidence must include at least one command/test-shaped item before a "verified" verdict is possible -- a tool_result alone is not enough to call code work done. Kept as the one place this requirement lives. */
const KINDS_REQUIRING_COMMAND_EVIDENCE: ReadonlySet<InspectionTaskKind> = new Set(["code"]);
const COMMAND_EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set(["command_output", "test_output"]);

export interface InspectorOptions {
  readonly now?: () => Date;
}

export class Inspector {
  private readonly now: () => Date;

  constructor(options: InspectorOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Judges `evidence` against `task`, never `task.claimedStatus` alone.
   * Rules, in order:
   *   1. No evidence at all -> "unverified" (we don't know).
   *   2. `task.kind` requires command/test evidence (see
   *      KINDS_REQUIRING_COMMAND_EVIDENCE) and none was supplied -> "unverified".
   *   3. Any evidence item observed a failure -> "failed", regardless of
   *      what else was supplied or what the task claims.
   *   4. Otherwise -> "verified".
   */
  async verify(task: InspectionTask, evidence: readonly Evidence[]): Promise<VerificationResult> {
    const verifiedAt = this.now().toISOString();

    if (evidence.length === 0) {
      return Object.freeze({
        status: "unverified" as const,
        reason: "no evidence was supplied to verify against",
        evidenceConsidered: 0,
        verifiedAt,
      });
    }

    if (
      KINDS_REQUIRING_COMMAND_EVIDENCE.has(task.kind) &&
      !evidence.some((item) => COMMAND_EVIDENCE_KINDS.has(item.kind))
    ) {
      return Object.freeze({
        status: "unverified" as const,
        reason: `task kind "${task.kind}" requires command or test output evidence, and none was supplied`,
        evidenceConsidered: evidence.length,
        verifiedAt,
      });
    }

    const failure = evidence.find((item) => item.outcome === "failure");
    if (failure) {
      return Object.freeze({
        status: "failed" as const,
        reason: `evidence contradicts success: ${failure.detail}`,
        evidenceConsidered: evidence.length,
        verifiedAt,
      });
    }

    return Object.freeze({
      status: "verified" as const,
      reason: "all supplied evidence is consistent with success",
      evidenceConsidered: evidence.length,
      verifiedAt,
    });
  }
}
