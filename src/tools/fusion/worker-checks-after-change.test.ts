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
  CHECK_STOP_NOTE,
  CHECKS_RUN_BY_RUNTIME_RULE,
  checkFailureSignature,
  formatCheckResultSteer,
} from "./worker-prompt.js";

/**
 * The runtime runs a worker's own contract checks after a step that
 * changed a file and steers the result in before the next step (k8z).
 * Measured (k8x): the core worker wrote and ran its own copies of the
 * checks — 16 `os.shell.run` calls, 145 s of generation.
 */

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

/** One scripted worker step: the files it writes (`os.fs.write` once, then `os.fs.edit`). */
interface Step {
  writes?: string[];
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
  let writes = 0;
  const deps: WorkerRunnerDeps = {
    runTurn: async (session: SessionState, message: string, options: TurnOptions) => {
      briefs.push(message);
      inbox.open(session.id);
      const written = new Set<string>();
      for (let i = 0; i < script.length; i += 1) {
        await options.beforeStep?.(i);
        options.eventHook?.({ type: "step_started", stepIndex: i } as never);
        readAt.push([...inbox.drain(session.id)]);
        for (const file of script[i]!.writes ?? []) {
          const path = join(dir, file);
          writes += 1;
          writeFileSync(path, `v${writes}`);
          options.eventHook?.(executed(written.has(path) ? "os.fs.edit" : "os.fs.write", path, writes));
          written.add(path);
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
  return { deps, briefs, readAt };
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
    expect(h.readAt[3]![0]).toContain("Nothing else fails: reply now");
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
    expect(text).toContain("Fix the first failure");
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
});
