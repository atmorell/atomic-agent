import type { AutoVerifyReport } from "./autoverify.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * The line that tells the orchestrator the review is done. Without it the
 * orchestrator read the whole diff again after a green judge and a passing
 * verify (k3d, 16-11-2026: one 15.7k-token step of a 0.674 run).
 */
export const REVIEWED_NOTE =
  "reviewed: the judge read every task's diff against its acceptance items (all green) and the verify command passed on these files unchanged since. Do not re-read the diff; reply, or read one file only if a specific line here is in doubt.";

export interface ReviewedNoteInput {
  results: readonly WorkerTaskResult[];
  autoverify: AutoVerifyReport | undefined;
  /**
   * The fan-out has more for the orchestrator than its rows: it was
   * cancelled or stopped by a cap or a breaker, left work to replan,
   * carried rows over from a resume, or merged isolated branches.
   */
  unsettled: boolean;
}

/** Every item green, each ruled on by a fact or by the judge reading files it saw whole. */
function judgedGreen(row: WorkerTaskResult): boolean {
  const judge = row.judge;
  return (
    row.status === "ok" &&
    judge !== undefined &&
    judge.green &&
    judge.unverified === undefined &&
    judge.clipped !== true &&
    judge.items.length > 0 &&
    judge.items.every((item) => item.pass && item.by !== "skipped") &&
    // A list the facts closed alone was never read by the judge.
    judge.items.some((item) => item.by === "judge")
  );
}

/**
 * `REVIEWED_NOTE` when nothing is left to review: every task judged green
 * on whole evidence, then a verify that passed with no repair (a repair
 * writes after the judge, so no Claude would have read that code), and
 * nothing unsettled. `undefined` otherwise; the orchestrator reviews as
 * before.
 */
export function reviewedNote(input: ReviewedNoteInput): string | undefined {
  const { results, autoverify } = input;
  if (input.unsettled || results.length === 0) return undefined;
  if (autoverify === undefined || autoverify.status !== "pass") return undefined;
  if (autoverify.repairs.length > 0) return undefined;
  return results.every(judgedGreen) ? REVIEWED_NOTE : undefined;
}
