import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { SteeringInbox } from "../../runtime/steering-inbox.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import type { ContractCheckRunner } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  CHECK_DOUBT_NOTE,
  CHECK_FAILING_RUNS_STOP,
  CHECK_IDLE_HOLD_STEPS,
  CHECK_IDLE_STEER_STEPS,
  CHECK_RUNS_STOP_NOTE,
  CHECK_STOP_NOTE,
  CHECKS_GREEN_HOLD_NOTICE,
  CHECKS_IDLE_HOLD_NOTICE,
  CHECKS_RUN_BY_RUNTIME_RULE,
  CHECKS_RUNS_STOPPED_HOLD_NOTICE,
  CHECKS_STOPPED_HOLD_NOTICE,
  checkFailureSignature,
  failingCheckLine,
  formatCheckIdleSteer,
  formatCheckResultSteer,
} from "./worker-prompt.js";

/**
 * The runtime runs a worker's own contract checks after a step that
 * changed a file and steers the result in before the next step (k8z).
 * Measured (k8x): the core worker wrote and ran its own copies of the
 * checks — 16 `os.shell.run` calls, 145 s of generation.
 */

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

/**
 * One scripted worker step: the files it writes (`os.fs.write` once, then
 * `os.fs.edit`), and edits the tool refused (`status: "error"`).
 */
interface Step {
  writes?: string[];
  refused?: string[];
}

function refusedEdit(path: string): never {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: {
        tool: "os.fs.edit",
        status: "error",
        summary: "os.fs.edit: `newString` must differ from `oldString`",
        details: { path },
        truncated: false,
      },
      batchIndex: 0,
      batchSize: 1,
    },
  } as never;
}

function executed(tool: string, path: string, n: number): never {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool, status: "ok", summary: `${tool} ${path} #${n}`, details: { path }, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  } as never;
}

/**
 * A worker turn that behaves like `AgentLoop` at its step boundaries:
 * awaits `beforeStep`, then drains the inbox into that step.
 */
function harness(dir: string, script: Step[], runChecks?: ContractCheckRunner) {
  const inbox = new SteeringInbox();
  const briefs: string[] = [];
  /** What each step read from the inbox, by step index. */
  const readAt: string[][] = [];
  /** What `beforeStep` returned for each step: a terminal hold, or undefined. */
  const holds: unknown[] = [];
  /** The write scope `beforeStep` returned for each step (greb K), or undefined. */
  const scopes: unknown[] = [];
  let writes = 0;
  const deps: WorkerRunnerDeps = {
    runTurn: async (session: SessionState, message: string, options: TurnOptions) => {
      briefs.push(message);
      inbox.open(session.id);
      const written = new Set<string>();
      for (let i = 0; i < script.length; i += 1) {
        const held = await options.beforeStep?.(i);
        const terminal = typeof held === "object" && held !== null && "terminalOnly" in held;
        holds.push(terminal ? held : undefined);
        scopes.push(terminal ? undefined : held);
        options.eventHook?.({ type: "step_started", stepIndex: i } as never);
        readAt.push([...inbox.drain(session.id)]);
        for (const file of script[i]!.writes ?? []) {
          const path = join(dir, file);
          writes += 1;
          writeFileSync(path, `v${writes}`);
          options.eventHook?.(executed(written.has(path) ? "os.fs.edit" : "os.fs.write", path, writes));
          written.add(path);
        }
        for (const file of script[i]!.refused ?? []) {
          options.eventHook?.(refusedEdit(join(dir, file)));
        }
        options.eventHook?.({ type: "step_finished", stepIndex: i } as never);
      }
      return {
        session,
        reason: "reply",
        stepCount: script.length,
        undelivered: inbox.closeAndDrain(session.id),
      } as RunTurnResult;
    },
    createEphemeralSession: (meta: FusionWorkerMeta) =>
      createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}1`,
        workingDir: dir,
        metadata: { fusionWorker: { ...meta } },
      }),
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: dir,
    steerWorker: (sessionId, text) => inbox.push(sessionId, text),
    ...(runChecks === undefined ? {} : { runChecks }),
  };
  return { deps, briefs, readAt, holds, scopes };
}

/** A runner that answers each spec with the next verdict list; records every call. */
function fakeRunner(verdicts: Array<Array<{ ok: boolean; error?: string }>>) {
  const calls: Array<readonly Record<string, unknown>[]> = [];
  const runner: ContractCheckRunner = async (specs) => {
    const verdict = verdicts[Math.min(calls.length, verdicts.length - 1)]!;
    calls.push(specs);
    return { ok: verdict.every((v) => v.ok), results: verdict };
  };
  return { runner, calls };
}

const CHECKS: DelegateContract["checks"] = [
  { task: "core", kind: "command", cmd: "python", args: ["-c", "import core; assert core.parse('a') == 1"] },
  { task: "core", kind: "command", cmd: "python", args: ["core.py", "--bad"] },
  { task: "other", kind: "command", cmd: "node", args: ["--check", "other.js"] },
];

function run(deps: WorkerRunnerDeps, files: string[] = ["core.py", "cli.py"]) {
  const task: DelegateTask = { id: "core", title: "Core", instructions: "write core", files };
  return runWorkerTasks(deps, {
    parentSessionId: "s-parent",
    providerId: "local",
    workerModel: "small",
    workerMaxSteps: 20,
    workerTimeoutMs: 600_000,
    maxWorkers: 1,
    tasks: [task],
    contract: { checks: CHECKS },
    signal: new AbortController().signal,
  });
}

describe("a worker's checks run by the runtime after a change (k8z)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-checks-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("steers the failures into the next step, with the task's own checks only", async () => {
    const { runner, calls } = fakeRunner([
      [{ ok: false, error: "AssertionError: 2 != 1" }, { ok: true }],
    ]);
    const h = harness(dir, [{ writes: ["core.py", "cli.py"] }, {}], runner);
    await run(h.deps);
    expect(calls).toHaveLength(1);
    // The task tag is stripped and a sibling's check is not run.
    expect(calls[0]).toEqual([
      { kind: "command", cmd: "python", args: ["-c", "import core; assert core.parse('a') == 1"] },
      { kind: "command", cmd: "python", args: ["core.py", "--bad"] },
    ]);
    expect(h.readAt[0]).toEqual([]);
    expect(h.readAt[1]).toHaveLength(1);
    expect(h.readAt[1]![0]).toContain("1 of 2 failed");
    expect(h.readAt[1]![0]).toContain("AssertionError: 2 != 1");
    expect(h.readAt[1]![0]).toContain("python -c import core; assert core.parse('a') == 1");
  });

  it("runs nothing until every declared file exists", async () => {
    const { runner, calls } = fakeRunner([[{ ok: true }, { ok: true }]]);
    const h = harness(dir, [{ writes: ["core.py"] }, { writes: ["cli.py"] }, {}], runner);
    await run(h.deps);
    expect(calls).toHaveLength(1);
    expect(h.readAt[1]).toEqual([]);
    expect(h.readAt[2]![0]).toContain("all passed");
  });

  it("runs nothing after a step without a write, and says an unchanged all-green once", async () => {
    const { runner, calls } = fakeRunner([[{ ok: true }, { ok: true }]]);
    const h = harness(
      dir,
      [{ writes: ["core.py", "cli.py"] }, {}, { writes: ["core.py"] }, {}],
      runner,
    );
    await run(h.deps);
    // After step 0 and step 2 — not after the read-only step 1.
    expect(calls).toHaveLength(2);
    expect(h.readAt[1]![0]).toContain("reply now");
    expect(h.readAt[3]).toEqual([]);
  });

  it("holds the next step until the run is done", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ContractCheckRunner = async () => {
      await gate;
      return { ok: false, results: [{ ok: false, error: "exit 1" }, { ok: true }] };
    };
    const h = harness(dir, [{ writes: ["core.py", "cli.py"] }, {}], runner);
    const done = run(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.readAt).toHaveLength(1);
    release();
    await done;
    expect(h.readAt[1]![0]).toContain("1 of 2 failed");
  });

  // The same failure on every run, with the run's timing and throwaway copy varying.
  const same = (n: number) => ({
    ok: false,
    error: `Traceback: File "C:\\Temp\\fusion-check-${n}\\core.py", line 3 AssertionError exit 1 after ${100 + n * 37} ms`,
  });
  const writeCore = (steps: number): Step[] => [
    { writes: ["core.py", "cli.py"] },
    ...Array.from({ length: steps - 1 }, () => ({ writes: ["core.py"] })),
    {},
  ];

  it("doubts a failure that came back unchanged, stops it the third time, then goes silent", async () => {
    const { runner, calls } = fakeRunner([1, 2, 3, 4].map((n) => [same(n), { ok: true }]));
    const h = harness(dir, writeCore(4), runner);
    await run(h.deps);
    expect(calls).toHaveLength(4);
    expect(h.readAt[1]![0]).toContain("1 of 2 failed");
    expect(h.readAt[1]![0]).not.toContain(CHECK_DOUBT_NOTE);
    expect(h.readAt[2]![0]).toContain(CHECK_DOUBT_NOTE);
    expect(h.readAt[3]![0]).toContain(CHECK_STOP_NOTE);
    // The third identical failure is also the third failing run in a row.
    expect(h.readAt[3]![0]).toContain(CHECK_RUNS_STOP_NOTE);
    expect(h.readAt[4]).toEqual([]);
  });

  it("never escalates a failure that changes", async () => {
    const { runner } = fakeRunner(
      [1, 2, 3, 4].map((line) => [{ ok: false, error: `AssertionError on line ${line}` }, { ok: true }]),
    );
    const h = harness(dir, writeCore(4), runner);
    await run(h.deps);
    for (const step of [1, 2, 3, 4]) {
      expect(h.readAt[step]![0]).toContain("1 of 2 failed");
      expect(h.readAt[step]![0]).not.toContain(CHECK_DOUBT_NOTE);
      expect(h.readAt[step]![0]).not.toContain(CHECK_STOP_NOTE);
    }
  });

  it("steers only a new failure next to one the worker was told to stop on", async () => {
    const { runner } = fakeRunner([
      ...[1, 2, 3].map((n) => [same(n), { ok: true }]),
      [same(4), { ok: false, error: "exit 2: usage" }],
    ]);
    const h = harness(dir, writeCore(4), runner);
    await run(h.deps);
    const text = h.readAt[4]![0]!;
    expect(text).toContain("2 of 2 failed");
    expect(text).toContain("- `python core.py --bad`: exit 2: usage");
    expect(text).not.toContain("line 3 AssertionError");
    expect(text).toContain("- +1 failing that you were told to stop working on — leave it");
    // Fourth failing run in a row: the run count says stop, not fix.
    expect(text).toContain(CHECK_RUNS_STOP_NOTE);
    expect(text).not.toContain("Fix the first failure");
  });

  it("starts over when a stopped check passes and then fails again", async () => {
    const { runner } = fakeRunner([
      ...[1, 2, 3].map((n) => [same(n), { ok: true }]),
      [{ ok: true }, { ok: true }],
      [same(5), { ok: true }],
    ]);
    const h = harness(dir, writeCore(5), runner);
    await run(h.deps);
    expect(h.readAt[4]![0]).toContain("all passed");
    expect(h.readAt[5]![0]).toContain("1 of 2 failed");
    expect(h.readAt[5]![0]).not.toContain(CHECK_DOUBT_NOTE);
  });

  // k8ag: green at 223 s, the worker kept going to the 600 s limit.
  it("holds the step after an all-green run to reply only", async () => {
    const { runner } = fakeRunner([[{ ok: true }, { ok: true }]]);
    const h = harness(dir, [{ writes: ["core.py", "cli.py"] }, {}], runner);
    await run(h.deps);
    expect(h.holds[0]).toBeUndefined();
    expect(h.holds[1]).toEqual({ terminalOnly: true, notice: CHECKS_GREEN_HOLD_NOTICE });
    expect(h.readAt[1]![0]).toContain("all passed");
  });

  it("holds nothing while a check fails or before every file exists", async () => {
    const { runner } = fakeRunner([[{ ok: false, error: "exit 1" }, { ok: true }]]);
    const failing = harness(dir, [{ writes: ["core.py", "cli.py"] }, {}], runner);
    await run(failing.deps);
    expect(failing.holds).toEqual([undefined, undefined]);
    const green = fakeRunner([[{ ok: true }, { ok: true }]]);
    const partial = harness(dir, [{ writes: ["core.py"] }, {}], green.runner);
    await run(partial.deps, ["core.py", "missing.py"]);
    expect(green.calls).toHaveLength(0);
    expect(partial.holds).toEqual([undefined, undefined]);
    // Greb K: the write scope rides on the same hook, checks or not.
    expect(failing.scopes[0]).toBeUndefined();
    expect(failing.scopes[1]).toMatchObject({ writePaths: [] });
    expect((partial.scopes[1] as { writePaths: string[] }).writePaths).toContain("missing.py");
    expect((partial.scopes[1] as { writePaths: string[] }).writePaths.some((path) => /core/.test(path))).toBe(false);
  });

  it("reopens after a change and holds again only once the checks are green", async () => {
    const { runner } = fakeRunner([
      [{ ok: true }, { ok: true }],
      [{ ok: false, error: "exit 1" }, { ok: true }],
      [{ ok: true }, { ok: true }],
    ]);
    const h = harness(
      dir,
      [{ writes: ["core.py", "cli.py"] }, { writes: ["core.py"] }, { writes: ["core.py"] }, {}],
      runner,
    );
    await run(h.deps);
    expect(h.holds[1]).toMatchObject({ terminalOnly: true });
    expect(h.holds[2]).toBeUndefined();
    expect(h.holds[3]).toMatchObject({ terminalOnly: true });
  });

  // k8ad: stopped at 282 s, the worker edited against a wrong assert to 600 s.
  const stoppedHold = { terminalOnly: true, notice: CHECKS_STOPPED_HOLD_NOTICE };
  // k8at: the core worker's checks failed 10 runs in a row; each edit
  // moved the failure, so the same-failure stop counted only 2 repeats.
  const runsStoppedHold = { terminalOnly: true, notice: CHECKS_RUNS_STOPPED_HOLD_NOTICE };

  it("holds the step after the third identical failure to reply only, not at the doubt", async () => {
    const { runner } = fakeRunner([1, 2, 3].map((n) => [same(n), { ok: true }]));
    const h = harness(dir, writeCore(3), runner);
    await run(h.deps);
    expect(h.holds.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(h.holds[3]).toEqual(stoppedHold);
    expect(h.readAt[3]![0]).toContain(CHECK_STOP_NOTE);
  });

  it("keeps the hold through a silent fourth run", async () => {
    const { runner, calls } = fakeRunner([1, 2, 3, 4].map((n) => [same(n), { ok: true }]));
    const h = harness(dir, writeCore(4), runner);
    await run(h.deps);
    expect(calls).toHaveLength(4);
    expect(h.readAt[4]).toEqual([]);
    expect(h.holds[4]).toEqual(stoppedHold);
  });

  // Greb J: from the third failing run in a row the run count holds, so
  // when the same-failure hold drops, the run-count hold is what is left.
  it("drops the same-failure hold while another check fails openly next to a stopped one", async () => {
    const { runner } = fakeRunner([
      ...[1, 2, 3].map((n) => [same(n), { ok: true }]),
      [same(4), { ok: false, error: "exit 2: usage" }],
    ]);
    const h = harness(dir, writeCore(4), runner);
    await run(h.deps);
    expect(h.holds[3]).toEqual(stoppedHold);
    expect(h.holds[4]).toEqual(runsStoppedHold);
  });

  it("drops the same-failure hold when the stopped failure changes", async () => {
    const { runner } = fakeRunner([
      ...[1, 2, 3].map((n) => [same(n), { ok: true }]),
      [{ ok: false, error: "AssertionError on line 9" }, { ok: true }],
    ]);
    const h = harness(dir, writeCore(4), runner);
    await run(h.deps);
    expect(h.holds[3]).toEqual(stoppedHold);
    expect(h.holds[4]).toEqual(runsStoppedHold);
    expect(h.readAt[4]![0]).toContain("1 of 2 failed");
    expect(h.readAt[4]![0]).toContain(CHECK_RUNS_STOP_NOTE);
  });

  // k8ak: one wrong assert failed 5 runs with a new message each time and
  // never reached doubt; the check's own line is what stays the same.
  const atCheckLine = (n: number, line = 4) => ({
    ok: false,
    error: `verify.run command: FAILED exit 1 after ${90 + n} ms stderr (tail): Traceback (most recent call last): File "<string>", line ${line}, in <module> File "C:\\Temp\\k8ak\\ark\\formel.py", line ${70 + n * 3}, in parse AssertionError: got ${n}`,
  });

  it("stops and holds a failure at the same check line whose message changes every run", async () => {
    const { runner } = fakeRunner([1, 2, 3].map((n) => [atCheckLine(n), { ok: true }]));
    const h = harness(dir, writeCore(3), runner);
    await run(h.deps);
    expect(h.readAt[2]![0]).toContain(CHECK_DOUBT_NOTE);
    expect(h.readAt[3]![0]).toContain(CHECK_STOP_NOTE);
    expect(h.holds[3]).toEqual(stoppedHold);
  });

  it("starts the same-failure count over when the failure moves to another check line", async () => {
    const { runner } = fakeRunner([
      [atCheckLine(1), { ok: true }],
      [atCheckLine(2), { ok: true }],
      [atCheckLine(3, 5), { ok: true }],
    ]);
    const h = harness(dir, writeCore(3), runner);
    await run(h.deps);
    expect(h.readAt[2]![0]).toContain(CHECK_DOUBT_NOTE);
    expect(h.readAt[3]![0]).not.toContain(CHECK_DOUBT_NOTE);
    expect(h.readAt[3]![0]).not.toContain(CHECK_STOP_NOTE);
    // Only the run count stops it: three failing runs in a row.
    expect(h.readAt[3]![0]).toContain(CHECK_RUNS_STOP_NOTE);
    expect(h.holds[3]).toEqual(runsStoppedHold);
  });

  // k8an: 19 steps without a write under a failing check, 222-478 s; the
  // checks run only after a change, so the doubt and the stop never came.
  const idleHold = { terminalOnly: true, notice: CHECKS_IDLE_HOLD_NOTICE };
  const idle = (n: number): Step[] => Array.from({ length: n }, () => ({}));
  const both: Step = { writes: ["core.py", "cli.py"] };
  const failing = () => fakeRunner([[{ ok: false, error: "exit 1" }, { ok: true }]]);
  const idleSteers = (readAt: string[][]) =>
    readAt.flat().filter((text) => text.startsWith("A check of your task still fails"));

  it("steers a worker that changes nothing under a failing check once, then holds it to reply", async () => {
    const h = harness(dir, [both, ...idle(CHECK_IDLE_HOLD_STEPS + 1)], failing().runner);
    await run(h.deps);
    expect(h.readAt[1]![0]).toContain("1 of 2 failed");
    expect(h.readAt[CHECK_IDLE_STEER_STEPS + 1]).toEqual([formatCheckIdleSteer(CHECK_IDLE_STEER_STEPS)]);
    expect(idleSteers(h.readAt)).toHaveLength(1);
    expect(h.holds.slice(0, CHECK_IDLE_HOLD_STEPS + 1).every((hold) => hold === undefined)).toBe(true);
    expect(h.holds[CHECK_IDLE_HOLD_STEPS + 1]).toEqual(idleHold);
  });

  it("counts again from a successful write", async () => {
    const h = harness(
      dir,
      [both, {}, {}, { writes: ["core.py"] }, ...idle(CHECK_IDLE_HOLD_STEPS)],
      failing().runner,
    );
    await run(h.deps);
    expect(idleSteers(h.readAt)).toHaveLength(1);
    expect(idleSteers([h.readAt[3 + CHECK_IDLE_STEER_STEPS + 1]!])).toHaveLength(1);
    expect(h.holds.every((hold) => hold === undefined)).toBe(true);
  });

  it("counts a refused edit as no change and quotes it in the steer", async () => {
    const h = harness(
      dir,
      [both, { refused: ["core.py"] }, {}, { refused: ["core.py"] }, {}, {}],
      failing().runner,
    );
    await run(h.deps);
    expect(h.readAt[5]).toEqual([
      formatCheckIdleSteer(4, "os.fs.edit: `newString` must differ from `oldString`"),
    ]);
  });

  it("counts nothing when the checks have not run", async () => {
    const { runner, calls } = fakeRunner([[{ ok: false, error: "exit 1" }, { ok: true }]]);
    const h = harness(dir, [{ writes: ["core.py"] }, ...idle(CHECK_IDLE_HOLD_STEPS + 1)], runner);
    await run(h.deps, ["core.py", "missing.py"]);
    expect(calls).toHaveLength(0);
    expect(h.readAt.flat()).toEqual([]);
    expect(h.holds.every((hold) => hold === undefined)).toBe(true);
  });

  it("keeps the stop-hold's notice when the worker is also idle", async () => {
    const { runner } = fakeRunner([1, 2, 3].map((n) => [same(n), { ok: true }]));
    const h = harness(dir, [...writeCore(3), ...idle(CHECK_IDLE_HOLD_STEPS)], runner);
    await run(h.deps);
    expect(h.holds[3 + CHECK_IDLE_HOLD_STEPS]).toEqual(stoppedHold);
  });

  const moving =(n: number) => [{ ok: false, error: `AssertionError on line ${n}` }, { ok: true }];
  const runs = CHECK_FAILING_RUNS_STOP;

  it("stops a worker whose checks failed run after run, though each failure differs", async () => {
    const { runner, calls } = fakeRunner(Array.from({ length: runs }, (_, i) => moving(i + 1)));
    const h = harness(dir, writeCore(runs), runner);
    await run(h.deps);
    expect(calls).toHaveLength(runs);
    expect(h.holds.slice(0, runs)).toEqual(Array.from({ length: runs }, () => undefined));
    expect(h.readAt[runs - 1]![0]).toContain("Fix the first failure");
    expect(h.readAt[runs]![0]).toContain(`line ${runs}`);
    expect(h.readAt[runs]![0]).toContain(CHECK_RUNS_STOP_NOTE);
    expect(h.readAt[runs]![0]).not.toContain("Fix the first failure");
    expect(h.holds[runs]).toEqual(runsStoppedHold);
  });

  it("counts the failing runs again from an all-green run", async () => {
    const { runner } = fakeRunner([
      ...Array.from({ length: runs - 1 }, (_, i) => moving(i + 1)),
      [{ ok: true }, { ok: true }],
      ...Array.from({ length: runs - 1 }, (_, i) => moving(i + 10)),
    ]);
    const h = harness(dir, writeCore(2 * runs - 1), runner);
    await run(h.deps);
    expect(h.readAt.flat().some((text) => text.includes(CHECK_RUNS_STOP_NOTE))).toBe(false);
    expect(h.holds.at(-1)).toBeUndefined();
  });

  it("keeps the same-failure stop's notice past the run count", async () => {
    const { runner } = fakeRunner(Array.from({ length: runs }, (_, i) => [same(i + 1), { ok: true }]));
    const h = harness(dir, writeCore(runs), runner);
    await run(h.deps);
    expect(h.holds[runs]).toEqual(stoppedHold);
  });

  it("tells the worker in its brief only when the runtime will run them", async () => {
    const { runner } = fakeRunner([[{ ok: true }, { ok: true }]]);
    const wired = harness(dir, [{}], runner);
    await run(wired.deps);
    expect(wired.briefs[0]).toContain(CHECKS_RUN_BY_RUNTIME_RULE);
    const unwired = harness(dir, [{}]);
    await run(unwired.deps);
    expect(unwired.briefs[0]).not.toContain(CHECKS_RUN_BY_RUNTIME_RULE);
  });
});

describe("formatCheckIdleSteer", () => {
  it("asks for one exact edit or a reply", () => {
    const text = formatCheckIdleSteer(4);
    expect(text).toContain("changed no file in 4 steps");
    expect(text).toContain("os.fs.edit");
    expect(text).not.toContain("Your last edit failed");
  });

  it("quotes the last refused edit on its own line", () => {
    const text = formatCheckIdleSteer(4, "os.fs.edit: old text not found");
    expect(text.split("\n")).toEqual([formatCheckIdleSteer(4), "Your last edit failed: os.fs.edit: old text not found"]);
  });
});

describe("formatCheckResultSteer", () => {
  const checks = [
    { task: "core", kind: "command", cmd: "python", args: ["-c", "assert 1"] },
    { task: "core", kind: "service", port: 8000 },
    { task: "core", kind: "command", cmd: "python", args: ["a.py"] },
    { task: "core", kind: "command", cmd: "python", args: ["b.py"] },
  ];

  it("names the first three failures and counts the rest", () => {
    const text = formatCheckResultSteer(checks, checks.map(() => ({ ok: false, detail: "exit 1" })));
    expect(text.split("\n")[0]).toBe("The runtime ran your task's checks after your last change: 4 of 4 failed.");
    expect(text).toContain("- `python -c assert 1`: exit 1");
    expect(text).toContain('- `{"kind":"service","port":8000}`: exit 1');
    expect(text).not.toContain("b.py");
    expect(text).toContain("- +1 more failing");
    expect(text).toContain("do not run them yourself");
  });

  it("asks for the reply when all passed", () => {
    const text = formatCheckResultSteer(checks.slice(0, 1), [{ ok: true, detail: "passed" }]);
    expect(text).toContain("1 check after your last change: all passed");
    expect(text).toContain("reply now");
  });

  it("puts the doubt under a repeated failure and the stop after the open ones", () => {
    const outcomes = checks.slice(0, 3).map(() => ({ ok: false, detail: "exit 1" }));
    const text = formatCheckResultSteer(
      checks.slice(0, 3),
      outcomes,
      new Map([
        [0, "stop"],
        [1, "doubt"],
      ] as const),
    );
    expect(text).toBe(
      [
        "The runtime ran your task's checks after your last change: 3 of 3 failed.",
        '- `{"kind":"service","port":8000}`: exit 1',
        `  ${CHECK_DOUBT_NOTE}`,
        "- `python a.py`: exit 1",
        "- `python -c assert 1`: exit 1",
        `  ${CHECK_STOP_NOTE}`,
        "Fix the first failure with `os.fs.edit`; the runtime runs the checks again after your next change, so do not run them yourself.",
      ].join("\n"),
    );
  });

  // Greb J: in the runner a check reaches "stop" on the third failing run
  // in a row, which the run count now also stops; the formatter keeps it.
  it("says reply when every failure left is one the worker was told to stop on", () => {
    const text = formatCheckResultSteer(
      checks.slice(0, 2),
      [
        { ok: false, detail: "exit 1" },
        { ok: true, detail: "" },
      ],
      new Map([[0, "stop"]] as const),
    );
    expect(text).toContain(CHECK_STOP_NOTE);
    expect(text.split("\n").at(-1)).toBe(
      "Nothing else fails: reply now, naming each check you stopped on and what your task text says about it.",
    );
  });

  it("drops the doubt and says stop at the failing-run count", () => {
    const text = formatCheckResultSteer(
      checks.slice(0, 2),
      checks.slice(0, 2).map(() => ({ ok: false, detail: "exit 1" })),
      new Map([[1, "doubt"]] as const),
      true,
    );
    expect(text).not.toContain(CHECK_DOUBT_NOTE);
    expect(text).toContain("- `python -c assert 1`: exit 1");
    expect(text.split("\n").at(-1)).toBe(
      `${CHECK_RUNS_STOP_NOTE} Reply now, naming each check that still fails and what your task text says about it.`,
    );
  });
});

describe("checkFailureSignature", () => {
  it("ignores the run's timing and the throwaway copy's directories", () => {
    const a = checkFailureSignature(
      'verify.run command: FAILED exit 1 after 129 ms stderr (tail): File "C:\\Users\\a\\Temp\\fv-1x\\core.py", line 3',
    );
    const b = checkFailureSignature(
      'verify.run command: FAILED exit 1 after 4071 ms stderr (tail): File "C:\\Users\\a\\Temp\\fv-9q\\core.py", line 3',
    );
    expect(a).toBe(b);
    expect(a).toContain('File "core.py", line 3');
    expect(checkFailureSignature("/tmp/fv-1/src/core.py line 3  x")).toBe("core.py line 3 x");
  });

  it("keeps what tells two failures apart", () => {
    expect(checkFailureSignature("core.py, line 3")).not.toBe(checkFailureSignature("core.py, line 4"));
    expect(checkFailureSignature("assert 0.0 == '#CYKEL'")).not.toBe(checkFailureSignature("assert 0.0 == 1.0"));
  });

  it("is the inline script's own line and the raised class when the check raised", () => {
    const at = (message: string, codeLine: number) =>
      checkFailureSignature(
        `Traceback (most recent call last): File "<string>", line 7, in <module> File "C:\\T\\fv-1\\ark\\formel.py", line ${codeLine}, in parse raise ValueError('syntaksfejl: celle %r' % name) ValueError: ${message}`,
      );
    expect(at("syntaksfejl: celle 'S'", 72)).toBe("check-line:7 ValueError");
    expect(at("syntaksfejl: celle 'X'", 81)).toBe(at("syntaksfejl: celle 'S'", 72));
    expect(checkFailureSignature('File "<string>", line 7, in <module> AssertionError')).toBe(
      "check-line:7 AssertionError",
    );
    expect(checkFailureSignature('File "<string>", line 7, in <module> KeyError: 3')).not.toBe(
      checkFailureSignature('File "<string>", line 7, in <module> AssertionError'),
    );
  });

  it("names every frame of the script, so a shared helper's assert is told apart by its caller", () => {
    const a = checkFailureSignature('File "<string>", line 9, in <module> File "<string>", line 2, in eq AssertionError');
    const b = checkFailureSignature('File "<stdin>", line 11, in <module> File "<stdin>", line 2, in eq AssertionError');
    expect(a).toBe("check-line:9>2 AssertionError");
    expect(b).toBe("check-line:11>2 AssertionError");
  });
});

describe("failingCheckLine", () => {
  const script = "from ark import Ark\nb = Ark()\nb.saet('A1', '=SUM(2,3)')\nassert b.vaerdi('A1') == 5, b.vaerdi('A1')";
  const detail = 'Traceback (most recent call last): File "<string>", line 4, in <module> AssertionError: 4';

  it("quotes the script's line that raised, from `python -c` or from stdin", () => {
    expect(failingCheckLine({ cmd: "python", args: ["-c", script] }, detail)).toEqual({
      line: 4,
      source: "assert b.vaerdi('A1') == 5, b.vaerdi('A1')",
    });
    expect(
      failingCheckLine({ cmd: "python", args: ["-"], stdin: script }, detail.replace("<string>", "<stdin>")),
    ).toEqual({ line: 4, source: "assert b.vaerdi('A1') == 5, b.vaerdi('A1')" });
  });

  it("quotes nothing without a script frame or a script to read it from", () => {
    expect(failingCheckLine({ cmd: "python", args: ["-c", script] }, "exit 1 after 3 ms")).toBeUndefined();
    expect(failingCheckLine({ cmd: "python", args: ["t.py"] }, detail)).toBeUndefined();
    expect(failingCheckLine({ cmd: "python", args: ["-c", "x = 1"] }, detail)).toBeUndefined();
  });

  it("is carried under the failure in the steer", () => {
    const text = formatCheckResultSteer(
      [{ task: "core", kind: "command", cmd: "python", args: ["-c", script] }],
      [{ ok: false, detail }],
    );
    expect(text).toContain("\n  failing check line 4: `assert b.vaerdi('A1') == 5, b.vaerdi('A1')`");
  });
});
