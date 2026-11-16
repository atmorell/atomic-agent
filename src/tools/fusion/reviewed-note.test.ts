import { describe, expect, it } from "vitest";

import type { AutoVerifyReport } from "./autoverify.js";
import type { ItemVerdict, JudgeSummary } from "./judge.js";
import { REVIEWED_NOTE, reviewedNote } from "./reviewed-note.js";
import type { WorkerTaskResult } from "./worker-result.js";

const judgedItems: ItemVerdict[] = [
  { id: "a1", pass: true, why: "check passed", by: "fact" },
  { id: "a2", pass: true, why: "the diff does it", by: "judge" },
];

function judge(over: Partial<JudgeSummary> = {}): JudgeSummary {
  return {
    green: true,
    total: judgedItems.length,
    failed: 0,
    retried: false,
    costUsd: 0.01,
    items: judgedItems,
    ...over,
  };
}

function row(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "Models",
    status: "ok",
    reply: "Implemented models.py",
    stepCount: 5,
    durationMs: 1000,
    tools: { calls: 2, errors: 0, writes: 1, byTool: {} },
    judge: judge(),
    ...over,
  };
}

function pass(over: Partial<AutoVerifyReport> = {}): AutoVerifyReport {
  return {
    status: "pass",
    rounds: 1,
    exitCode: 0,
    excerpt: [],
    diffstat: [{ path: "models.py", added: 40, removed: 2 }],
    repairs: [],
    ...over,
  };
}

const settled = { unsettled: false };

describe("reviewedNote", () => {
  it("says the review is done when every task is judged green and the verify passed unrepaired", () => {
    expect(
      reviewedNote({ results: [row(), row({ id: "t2" })], autoverify: pass(), ...settled }),
    ).toBe(REVIEWED_NOTE);
    // The worker's own run reused as the pass is the same files, unchanged.
    expect(reviewedNote({ results: [row()], autoverify: pass({ reused: true }), ...settled })).toBe(
      REVIEWED_NOTE,
    );
    // Green after the judge's retry is green.
    expect(
      reviewedNote({ results: [row({ judge: judge({ retried: true }) })], autoverify: pass(), ...settled }),
    ).toBe(REVIEWED_NOTE);
  });

  it("is absent when a task was not judged green on evidence the judge read whole", () => {
    const rows: WorkerTaskResult[] = [
      row({ judge: undefined }),
      row({ judge: judge({ green: false, failed: 1 }) }),
      row({ judge: judge({ green: false, unverified: "the judge could not run" }) }),
      row({ judge: judge({ clipped: true }) }),
      row({
        judge: judge({
          items: [...judgedItems, { id: "a3", pass: true, why: "not judged", by: "skipped" }],
        }),
      }),
      // The facts closed the list alone: no judge read the diff.
      row({ judge: judge({ items: [{ id: "a1", pass: true, why: "check passed", by: "fact" }] }) }),
      row({ judge: judge({ items: [] }) }),
      row({ status: "failed", error: "checks: pytest failed" }),
      row({ status: "needs_orchestrator" }),
    ];
    for (const bad of rows) {
      expect(reviewedNote({ results: [row({ id: "t0" }), bad], autoverify: pass(), ...settled })).toBeUndefined();
    }
  });

  it("is absent when the verify did not pass, or passed only after a repair", () => {
    for (const autoverify of [
      undefined,
      pass({ status: "fail", exitCode: 1 }),
      pass({ status: "not_run", exitCode: null, reason: "cancelled" }),
      // The repair wrote after the judge ruled: no Claude read that code.
      pass({ rounds: 2, repairs: [{ id: "repair-1", status: "ok", stepCount: 4 }] }),
    ]) {
      expect(reviewedNote({ results: [row()], autoverify, ...settled })).toBeUndefined();
    }
  });

  it("is absent when the fan-out is unsettled or ran nothing", () => {
    expect(reviewedNote({ results: [row()], autoverify: pass(), unsettled: true })).toBeUndefined();
    expect(reviewedNote({ results: [], autoverify: pass(), ...settled })).toBeUndefined();
  });
});
