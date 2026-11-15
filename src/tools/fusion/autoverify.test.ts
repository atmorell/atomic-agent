import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { CancelledError } from "../../llm/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import {
  AUTOVERIFY_BLOCK_CHARS,
  AUTOVERIFY_CHANGE_LINES,
  AUTOVERIFY_EXCERPT_LINES,
  AUTOVERIFY_REPAIR_MAX_STEPS,
  changedLines,
  classifyVerifyResult,
  diffStat,
  failureExcerpt,
  readAutoVerifyArgs,
  renderAutoVerifyBlock,
  reusableWorkerRun,
  type AutoVerifyDispatch,
  type AutoVerifyReport,
} from "./autoverify.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { WorkerCommandRun } from "./worker-result.js";

const PYTEST_FAIL = [
  "============================= test session starts ==============================",
  "collected 3 items",
  "",
  "test_calc.py .F.                                                         [100%]",
  "",
  "=================================== FAILURES ===================================",
  "_________________________________ test_divide __________________________________",
  "",
  "    def test_divide():",
  ">       assert divide(6, 3) == 2.0",
  "E       assert 3 == 2.0",
  "E        +  where 3 = divide(6, 3)",
  "",
  "test_calc.py:9: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED test_calc.py::test_divide - assert 3 == 2.0",
  "========================= 1 failed, 2 passed in 0.02s ==========================",
].join("\n");

function verifyResult(ok: boolean, over: Record<string, unknown> = {}): CompressedToolResult {
  return compressToolResult({
    tool: "verify.run",
    status: ok ? "ok" : "error",
    output: ok ? "verify.run command: ok" : "verify.run command: FAILED\nFAIL check `exit 0` — exit 1",
    details: {
      ok,
      kind: "command",
      exitCode: ok ? 0 : 1,
      stdoutTail: ok ? "3 passed in 0.01s" : PYTEST_FAIL,
      stderrTail: "",
      description: "python -m pytest -q",
      checks: [],
      isolated: true,
      durationMs: 5,
      ...over,
    },
  });
}

function denied(): CompressedToolResult {
  return compressToolResult({
    tool: "verify.run",
    status: "error",
    output: "approval denied: python -m pytest -q",
    details: { errorName: "ApprovalDeniedError" },
  });
}

describe("autoverify pieces", () => {
  it("reads `verify` as absent, an object, or a refusal", () => {
    expect(readAutoVerifyArgs({})).toEqual({ ok: true, args: undefined });
    expect(readAutoVerifyArgs({ verify: { kind: "command", cmd: "x" } })).toEqual({
      ok: true,
      args: { kind: "command", cmd: "x" },
    });
    expect(readAutoVerifyArgs({ verify: "pytest" }).ok).toBe(false);
    expect(readAutoVerifyArgs({ verify: [1] }).ok).toBe(false);
  });

  it("keeps pytest's first assertion and its short summary", () => {
    expect(failureExcerpt(PYTEST_FAIL, "")).toEqual([
      ">       assert divide(6, 3) == 2.0",
      "E       assert 3 == 2.0",
      "E        +  where 3 = divide(6, 3)",
      "=========================== short test summary info ============================",
      "FAILED test_calc.py::test_divide - assert 3 == 2.0",
      "========================= 1 failed, 2 passed in 0.02s ==========================",
    ]);
  });

  it("caps the excerpt at 30 lines of at most 200 chars, falling back to the tail", () => {
    const noisy = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(i === 99 ? 500 : 1)}`).join("\n");
    const out = failureExcerpt(noisy, "");
    expect(out).toHaveLength(AUTOVERIFY_EXCERPT_LINES);
    expect(out[0]).toBe("line 70 x");
    expect(out.at(-1)!.length).toBe(201);
    const summary = Array.from({ length: 40 }, (_, i) => `FAILED t::c${i}`).join("\n");
    const many = `${"=".repeat(5)} short test summary info ${"=".repeat(5)}\n${summary}\n=== 40 failed ===`;
    expect(failureExcerpt(many, "")).toHaveLength(AUTOVERIFY_EXCERPT_LINES);
    expect(failureExcerpt("", "", "only the summary")).toEqual(["only the summary"]);
  });

  it("classifies a run, a run that could not start, and a call that never ran", () => {
    expect(classifyVerifyResult(verifyResult(true))).toEqual({
      ran: true,
      ok: true,
      exitCode: 0,
      command: "python -m pytest -q",
      excerpt: [],
    });
    const failed = classifyVerifyResult(verifyResult(false));
    expect(failed).toMatchObject({ ran: true, ok: false, exitCode: 1 });
    expect(failed.ran && failed.excerpt[0]).toBe(">       assert divide(6, 3) == 2.0");
    expect(classifyVerifyResult(verifyResult(false, { error: "spawn ENOENT" }))).toEqual({
      ran: false,
      reason: "the verify could not run: spawn ENOENT",
    });
    expect(classifyVerifyResult(denied())).toEqual({
      ran: false,
      reason: "ApprovalDeniedError: approval denied: python -m pytest -q",
    });
    const guarded = compressToolResult({
      tool: "verify.run",
      status: "error",
      output: "refused",
      details: { guardRule: "rm-root" },
    });
    expect(classifyVerifyResult(guarded)).toEqual({ ran: false, reason: "blocked by shell guard rule rm-root" });
  });

  it("counts a diff stat per changed file, sorted, order-blind", () => {
    const before = new Map<string, string | null>([
      ["b.py", "a\nb\nc\n"],
      ["a.py", "same\n"],
      ["new.py", null],
    ]);
    const after = new Map<string, string | null>([
      ["b.py", "a\nB\nc\nd\n"],
      ["a.py", "same\n"],
      ["new.py", "x\ny\n"],
    ]);
    expect(diffStat(before, after)).toEqual([
      { path: "b.py", added: 2, removed: 1 },
      { path: "new.py", added: 2, removed: 0 },
    ]);
  });

  it("lists the added lines in the new numbering, removed counts, capped", () => {
    const before = new Map<string, string | null>([
      ["t.mjs", "a\nb\nc\n"],
      ["new.mjs", null],
    ]);
    const after = new Map<string, string | null>([
      ["t.mjs", "a\nstop();\nc\n"],
      ["new.mjs", "x\n"],
    ]);
    expect(changedLines(before, after)).toEqual([
      "new.mjs:1 + x",
      "t.mjs:2 + stop();",
      "t.mjs: 1 line removed",
    ]);
    const many = new Map<string, string | null>([["t.mjs", Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n")]]);
    const lines = changedLines(new Map([["t.mjs", ""]]), many);
    expect(lines).toHaveLength(AUTOVERIFY_CHANGE_LINES + 1);
    expect(lines.at(-1)).toBe("… 10 more");
    expect(changedLines(before, before)).toEqual([]);
  });

  it("renders one compact block, deterministic and capped", () => {
    const report: AutoVerifyReport = {
      status: "fail",
      rounds: 3,
      exitCode: 1,
      command: "python -m pytest -q",
      excerpt: ["E   assert 3 == 2.0"],
      diffstat: [{ path: "calc.py", added: 2, removed: 1 }],
      repairs: [
        { id: "autoverify-repair-1", status: "ok", stepCount: 3 },
        { id: "autoverify-repair-2", status: "ok", stepCount: 2 },
      ],
      reason: "still failing after 2 repairs",
    };
    const block = renderAutoVerifyBlock(report);
    expect(block).toBe(
      [
        "autoverify: FAIL after 3 rounds (exit 1, 2 repairs: autoverify-repair-1 ok, autoverify-repair-2 ok) — `python -m pytest -q` — still failing after 2 repairs",
        "failure (1 line):",
        "  E   assert 3 == 2.0",
        "diffstat: calc.py +2 -1 (1 file, +2 -1)",
      ].join("\n"),
    );
    expect(renderAutoVerifyBlock(report)).toBe(block);
    expect(
      renderAutoVerifyBlock({ status: "not_run", rounds: 0, exitCode: null, excerpt: [], diffstat: [], repairs: [], reason: "cancelled" }),
    ).toBe("autoverify: NOT RUN — cancelled");
    const huge = renderAutoVerifyBlock({
      ...report,
      excerpt: Array.from({ length: 30 }, () => "y".repeat(200)),
    });
    expect(huge.length).toBeLessThanOrEqual(AUTOVERIFY_BLOCK_CHARS);
  });
});

describe("reusableWorkerRun", () => {
  const ROOT = resolve(tmpdir(), "reuse-root");
  const SPEC = { kind: "command", cmd: "python", args: ["-m", "pytest", "-q"], checks: ["exit 0"] };
  const RUN: WorkerCommandRun = {
    lines: ["python -m pytest -q"],
    cwd: ROOT,
    exitCode: 0,
    timedOut: false,
    durationMs: 900,
    stdoutTail: "3 passed in 0.02s",
    changedAfter: false,
  };
  const reuse = (spec: Record<string, unknown>, run: Partial<WorkerCommandRun> = {}) =>
    reusableWorkerRun(spec, { ...RUN, ...run }, ROOT);

  it("takes the worker's passing run of the same command in the same directory", () => {
    expect(reuse(SPEC)).toBe(true);
    expect(reuse({ kind: "command", cmd: "python", args: ["-m", "pytest", "-q"] })).toBe(true);
    expect(reuse({ ...SPEC, checks: ["exit == 0", 'stdout contains "3 passed"'] })).toBe(true);
    expect(reuse({ ...SPEC, cwd: "pkg" }, { cwd: join(ROOT, "pkg") })).toBe(true);
    expect(reuse({ ...SPEC, cwd: join(ROOT, "pkg") }, { cwd: join(ROOT, "pkg") })).toBe(true);
    expect(reuse({ ...SPEC, network: true, timeoutMs: 5_000 })).toBe(true);
  });

  it("runs the verify when there is no run, or a different one", () => {
    expect(reusableWorkerRun(SPEC, undefined, ROOT)).toBe(false);
    expect(reuse({ ...SPEC, args: ["-m", "pytest"] })).toBe(false);
    expect(reuse({ ...SPEC, cwd: "pkg" })).toBe(false);
    expect(reuse(SPEC, { cwd: join(ROOT, "pkg") })).toBe(false);
  });

  it("runs the verify when the run failed, timed out, ran too long or is stale", () => {
    expect(reuse(SPEC, { exitCode: 1 })).toBe(false);
    expect(reuse(SPEC, { exitCode: null })).toBe(false);
    expect(reuse(SPEC, { timedOut: true })).toBe(false);
    expect(reuse(SPEC, { changedAfter: true })).toBe(false);
    expect(reuse(SPEC, { durationMs: undefined })).toBe(false);
    expect(reuse(SPEC, { durationMs: 120_001 })).toBe(false);
    expect(reuse({ ...SPEC, timeoutMs: 300_000 }, { durationMs: 120_001 })).toBe(true);
  });

  it("runs the verify for anything it cannot judge from the run", () => {
    expect(reuse({ ...SPEC, env: { CI: "1" } })).toBe(false);
    expect(reuse({ kind: "service", start: { cmd: "python" }, ready: { port: 8000 } })).toBe(false);
    expect(reuse({ ...SPEC, cwd: ".." }, { cwd: resolve(ROOT, "..") })).toBe(false);
    expect(reuse({ ...SPEC, checks: ["exit != 0"] })).toBe(false);
    expect(reuse({ ...SPEC, checks: ['stdout not contains "FAILED"'] })).toBe(false);
    expect(reuse({ ...SPEC, checks: ['stderr contains "x"'] })).toBe(false);
    expect(reuse({ ...SPEC, checks: ['stdout contains "nope"'] })).toBe(false);
    expect(reuse({ ...SPEC, checks: ['stdout contains "3 passed"'] }, { stdoutTail: undefined })).toBe(false);
    expect(reuse({ ...SPEC, extra: 1 })).toBe(false);
  });

  it("runs the verify for a line with shell syntax or an argument with a space", () => {
    const piped = { ...SPEC, args: ["-m", "pytest", "-q", "|", "tail"] };
    expect(reuse(piped, { lines: ["python -m pytest -q | tail"] })).toBe(false);
    const spaced = { ...SPEC, args: ["-k", "a b"] };
    expect(reuse(spaced, { lines: ["python -k a b"] })).toBe(false);
  });

  it("says in the block that the pass is the worker's own run", () => {
    const head = renderAutoVerifyBlock({
      status: "pass",
      rounds: 1,
      exitCode: 0,
      command: "python -m pytest -q",
      excerpt: [],
      diffstat: [],
      repairs: [],
      reused: true,
    }).split("\n")[0];
    expect(head).toBe(
      "autoverify: PASS after 1 round (exit 0) — `python -m pytest -q` — reused the worker's own passing run (no file changed after it)",
    );
  });
});

// ── fusion.delegate with autoverify ─────────────────────────────────

const logger = new StructuredLogger({ level: "error", sinks: [] });

function fusionMode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "openrouter",
    orchestratorModel: "big",
    workerProviderId: "local-llama",
    workerModel: "small",
    workers: 3,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter",
    degraded: null,
    autoVerify: { maxRounds: 2 },
    ...over,
  };
}

function turnResult(session?: SessionState): RunTurnResult {
  return {
    session: session ?? createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 1,
  };
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "autoverify-"));
  writeFileSync(join(work, "calc.py"), "def divide(a, b):\n    return a // b\n");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const TASK = { id: "t1", title: "Calc", instructions: "Write divide", files: ["calc.py"] };
const VERIFY = { kind: "command", cmd: "python", args: ["-m", "pytest", "-q"], checks: ["exit 0"] };

function deps(
  dispatchVerify: AutoVerifyDispatch | undefined,
  runTurn: FusionDelegateDeps["runTurn"],
  mode: ResolvedRunMode = fusionMode(),
): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn,
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: work,
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: work,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode,
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...(dispatchVerify === undefined ? {} : { dispatchVerify }),
  };
}

function ctx(signal = new AbortController().signal): ToolContext {
  return { workingDir: work, sessionId: "s-parent", stepIndex: 0, signal };
}

/** Workers that edit calc.py; a repair brief is recorded and edits it again. */
function workers() {
  const briefs: string[] = [];
  const runTurn = vi.fn<FusionDelegateDeps["runTurn"]>(async (session, message) => {
    briefs.push(message);
    const fix = message.includes("its check fails");
    writeFileSync(
      join(work, "calc.py"),
      fix
        ? "def divide(a, b):\n    return a / b\n"
        : "def divide(a, b):\n    # integer\n    return a // b\n",
    );
    return turnResult(session);
  });
  return { briefs, runTurn, repairBriefs: () => briefs.filter((b) => b.includes("its check fails")) };
}

describe("fusion.delegate autoverify", () => {
  it("passes on the first try: one verify, no repair, PASS first in the output", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![0]).toEqual(VERIFY);
    expect(dispatch.mock.calls[0]![1].workingDir).toBe(work);
    expect(w.runTurn).toHaveBeenCalledOnce();
    expect(result.summary.split("\n").slice(0, 2)).toEqual([
      "autoverify: PASS after 1 round (exit 0) — `python -m pytest -q`",
      "diffstat: calc.py +1 -0 (1 file, +1 -0)",
    ]);
    expect((result.details.autoverify as AutoVerifyReport).status).toBe("pass");
  });

  it("fails, a local repair fixes it, and the second verify passes", async () => {
    let n = 0;
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(++n > 1));
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(w.runTurn).toHaveBeenCalledTimes(2);
    const [repair] = w.repairBriefs();
    expect(repair).toContain("E       assert 3 == 2.0");
    expect(repair).toContain("FAILED test_calc.py::test_divide - assert 3 == 2.0");
    expect(repair).toContain("Work done: t1 (Calc)");
    // The worker's own change is in the brief, and the repair runs on a
    // short leash: the configured 7 steps here, at most 12 anywhere.
    expect(repair).toContain("calc.py:2 +     # integer");
    const repairCall = w.runTurn.mock.calls.find((c) => String(c[1]).includes("its check fails"))!;
    expect(repairCall[2]?.maxSteps).toBe(7);
    expect(result.summary.split("\n")[0]).toBe(
      "autoverify: PASS after 2 rounds (exit 0, 1 repair: autoverify-repair-1 ok) — `python -m pytest -q`",
    );
    expect(readFileSync(join(work, "calc.py"), "utf8")).toContain("a / b");
    const report = result.details.autoverify as AutoVerifyReport;
    expect(report.excerpt).toEqual([]);
    expect(report.diffstat).toEqual([{ path: "calc.py", added: 1, removed: 1 }]);
  });

  it("caps a repair at 12 steps when the worker budget is larger", async () => {
    let n = 0;
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(++n > 1));
    const w = workers();
    await buildFusionDelegateTool(deps(dispatch, w.runTurn, fusionMode({ workerMaxSteps: 60 }))).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    const steps = w.runTurn.mock.calls.map((c) => c[2]?.maxSteps);
    expect(steps).toEqual([60, AUTOVERIFY_REPAIR_MAX_STEPS]);
    expect(AUTOVERIFY_REPAIR_MAX_STEPS).toBe(12);
  });

  it("still fails after the configured rounds: N repairs, N+1 verifies, the excerpt kept", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(false));
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(w.repairBriefs()).toHaveLength(2);
    const lines = result.summary.split("\n");
    expect(lines[0]).toBe(
      "autoverify: FAIL after 3 rounds (exit 1, 2 repairs: autoverify-repair-1 ok, autoverify-repair-2 ok) — `python -m pytest -q` — still failing after 2 repairs",
    );
    expect(lines[1]).toBe("failure (6 lines):");
    const report = result.details.autoverify as AutoVerifyReport;
    expect(report).toMatchObject({ status: "fail", rounds: 3, exitCode: 1 });
    expect(report.excerpt.length).toBeLessThanOrEqual(AUTOVERIFY_EXCERPT_LINES);
  });

  it("honours a configured round count of 0: one verify, no repair", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(false));
    const w = workers();
    const result = await buildFusionDelegateTool(
      deps(dispatch, w.runTurn, fusionMode({ autoVerify: { maxRounds: 0 } })),
    ).run({ tasks: [TASK], verify: VERIFY }, ctx());
    expect(dispatch).toHaveBeenCalledOnce();
    expect(w.repairBriefs()).toHaveLength(0);
    expect(result.summary.split("\n")[0]).toBe("autoverify: FAIL after 1 round (exit 1) — `python -m pytest -q`");
  });

  it("a denied verify does not run again and nothing is repaired", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => denied());
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(w.repairBriefs()).toHaveLength(0);
    expect(result.summary.split("\n")[0]).toBe(
      "autoverify: NOT RUN — ApprovalDeniedError: approval denied: python -m pytest -q",
    );
  });

  it("a denial on a later round leaves the last real failure standing", async () => {
    let n = 0;
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => (++n === 1 ? verifyResult(false) : denied()));
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(w.repairBriefs()).toHaveLength(1);
    const report = result.details.autoverify as AutoVerifyReport;
    expect(report).toMatchObject({ status: "fail", rounds: 1, exitCode: 1 });
    expect(report.reason).toContain("ApprovalDeniedError");
  });

  it("cancellation during the verify stops the loop: no repair, no second verify", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => {
      controller.abort();
      throw new CancelledError("operation cancelled");
    });
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(controller.signal),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(w.repairBriefs()).toHaveLength(0);
    expect(result.details.autoverify).toMatchObject({ status: "not_run", reason: "cancelled" });
    expect(result.summary.split("\n")[0]).toBe("autoverify: NOT RUN — cancelled");
  });

  it("a turn cancelled before the verify does not dispatch it", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    const runTurn = vi.fn(async (session: SessionState) => {
      controller.abort();
      return turnResult(session);
    });
    const result = await buildFusionDelegateTool(deps(dispatch, runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(controller.signal),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.details.autoverify).toMatchObject({ status: "not_run", reason: "cancelled" });
  });

  it("flag off or no dispatcher: `verify` is ignored, the output unchanged", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    const off = workers();
    const flagOff = await buildFusionDelegateTool(
      deps(dispatch, off.runTurn, fusionMode({ autoVerify: undefined })),
    ).run({ tasks: [TASK], verify: VERIFY }, ctx());
    const none = workers();
    const noDispatcher = await buildFusionDelegateTool(deps(undefined, none.runTurn)).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).not.toHaveBeenCalled();
    for (const result of [flagOff, noDispatcher]) {
      expect(result.summary).not.toContain("autoverify:");
      expect(result.details.autoverify).toBeUndefined();
    }
  });

  it("refuses a `verify` that is not an object, before any worker runs", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    const w = workers();
    const result = await buildFusionDelegateTool(deps(dispatch, w.runTurn)).run(
      { tasks: [TASK], verify: "pytest" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("`verify` must be a verify.run args object");
    expect(w.runTurn).not.toHaveBeenCalled();
  });
});

describe("fusion.delegate autoverify reuses the worker's passing run", () => {
  /** A worker that fixes calc.py, runs the verify's command itself, then maybe writes again. */
  function testingWorker(after?: "write") {
    return vi.fn<FusionDelegateDeps["runTurn"]>(async (session, _message, options) => {
      writeFileSync(join(work, "calc.py"), "def divide(a, b):\n    return a / b\n");
      const text = "$ python -m pytest -q\nexit: 0\n3 passed in 0.02s";
      options.eventHook?.({
        type: "llm_event",
        event: {
          type: "tool_call_executed",
          result: {
            tool: "os.shell.run",
            status: "ok",
            summary: text,
            fullOutput: text,
            details: {
              cmd: "python",
              args: ["-m", "pytest", "-q"],
              rawArgs: ["-m", "pytest", "-q"],
              cwd: work,
              shell: false,
              exitCode: 0,
              durationMs: 900,
              timedOut: false,
              truncated: false,
              outputStreams: "stdout",
            },
            truncated: false,
          },
          batchIndex: 0,
          batchSize: 1,
        },
      });
      if (after === "write") {
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: { tool: "os.fs.write", status: "ok", summary: "wrote calc.py", details: {}, truncated: false },
            batchIndex: 0,
            batchSize: 1,
          },
        });
      }
      return turnResult(session);
    });
  }

  it("passes without running the verify again when no file changed after the run", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    const result = await buildFusionDelegateTool(deps(dispatch, testingWorker())).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.summary.split("\n")[0]).toBe(
      "autoverify: PASS after 1 round (exit 0) — `python -m pytest -q` — reused the worker's own passing run (no file changed after it)",
    );
    const report = result.details.autoverify as AutoVerifyReport;
    expect(report).toMatchObject({ status: "pass", reused: true, rounds: 1, repairs: [] });
    expect(report.diffstat).toEqual([{ path: "calc.py", added: 1, removed: 1 }]);
  });

  it("runs the verify when the worker wrote after its run", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    const result = await buildFusionDelegateTool(deps(dispatch, testingWorker("write"))).run(
      { tasks: [TASK], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect((result.details.autoverify as AutoVerifyReport).reused).toBeUndefined();
  });

  it("runs the verify for a call of more than one task", async () => {
    const dispatch = vi.fn<AutoVerifyDispatch>(async () => verifyResult(true));
    await buildFusionDelegateTool(deps(dispatch, testingWorker())).run(
      { tasks: [TASK, { ...TASK, id: "t2", title: "More", files: ["more.py"] }], verify: VERIFY },
      ctx(),
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
