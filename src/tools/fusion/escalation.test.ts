import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import {
  FusionLiveWorkers,
  renderAdvisorPrompt,
  type EscalationComplete,
} from "./escalation.js";
import type { DelegateTask } from "./delegate-args.js";

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

const TARGET: FusionEscalationTarget = {
  providerId: "cloud",
  model: "big",
  auto: true,
  replace: false,
  maxUsd: 0.25,
};
const PRICING = { input: 1, output: 4 };
const TASK: DelegateTask[] = [{ id: "t0", title: "T0", instructions: "write a.txt" }];
const BASE = {
  parentSessionId: "s-parent",
  providerId: "local",
  workerModel: "small",
  workerMaxSteps: 20,
  workerTimeoutMs: 600_000,
  maxWorkers: 1,
};

/** One completed step whose only result is the same failing read. */
function sameStep(hook: TurnOptions["eventHook"], i: number): void {
  hook?.({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool: "os.fs.read", status: "error", summary: "not found: a.txt", details: {} },
    },
  } as never);
  hook?.({ type: "step_finished", stepIndex: i, summary: "", durationMs: 1 } as AgentLoopEvent);
}

function done(): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 3,
  } as RunTurnResult;
}

function harness(
  runTurn: (session: SessionState, options: TurnOptions) => Promise<RunTurnResult>,
  extra: Partial<WorkerRunnerDeps> = {},
) {
  let minted = 0;
  const events: AgentLoopEvent[] = [];
  const steers: string[] = [];
  const calls: string[] = [];
  const complete: EscalationComplete = async ({ providerId }) => {
    calls.push(providerId);
    return {
      content: "Stop reading a.txt; it does not exist yet. Write it with os.fs.write.",
      usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
    };
  };
  const deps: WorkerRunnerDeps = {
    runTurn: (session, _msg, options) => runTurn(session, options),
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: (_id, event) => events.push(event),
    workingDir: "/repo",
    escalationComplete: complete,
    steerWorker: (_id, text) => {
      steers.push(text);
      return true;
    },
    ...extra,
  };
  return { deps, events, steers, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("advisor escalation of a stuck worker (ATO-942)", () => {
  it("asks the escalation model once on a stall and steers the worker with its hint", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 6; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(h.calls).toEqual(["cloud"]);
    expect(h.steers[0]).toMatch(/Advice from a stronger model \(big\)/);
    // 1000 in at $1/M + 200 out at $4/M.
    expect(row!.notes?.join("\n")).toMatch(
      /escalated to big as advisor \(stalled: same result 3×\): \$0\.0018/,
    );
    const escalated = h.events.filter(
      (e) => e.type === "fusion_worker" && e.phase === "escalated",
    );
    expect(escalated.length).toBeGreaterThanOrEqual(2);
  });

  it("asks the advisor on the agent loop's loop the step check misses (k8n)", async () => {
    // k8n: the core worker alternated re-reads with successful diagnostic
    // runs; every step was busy and distinct, so `detectStall` never fired.
    const busyStep = (hook: TurnOptions["eventHook"], i: number): void => {
      hook?.({
        type: "llm_event",
        event: {
          type: "tool_call_executed",
          result: { tool: "os.shell.run", status: "ok", summary: `run ${i}`, details: {} },
        },
      } as never);
      hook?.({ type: "step_finished", stepIndex: i, summary: "", durationMs: 1 } as AgentLoopEvent);
    };
    const loop = (detector: "read_repeat" | "outcome_repeat"): AgentLoopEvent => ({
      type: "loop_detected",
      tool: "os.fs.read",
      count: detector === "read_repeat" ? 2 : 3,
      stepIndex: 4,
      level: "warn",
      detector,
    });
    const reread = harness(async (_s, options) => {
      for (let i = 0; i < 8; i += 1) busyStep(options.eventHook, i);
      options.eventHook?.(loop("read_repeat"));
      await flush();
      return done();
    });
    await runWorkerTasks(reread.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(reread.calls).toEqual([]);

    const h = harness(async (_s, options) => {
      for (let i = 0; i < 4; i += 1) busyStep(options.eventHook, i);
      options.eventHook?.(loop("outcome_repeat"));
      options.eventHook?.(loop("outcome_repeat"));
      await flush();
      for (let i = 4; i < 8; i += 1) busyStep(options.eventHook, i);
      return done();
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(h.calls).toEqual(["cloud"]);
    expect(row!.notes?.join("\n")).toMatch(
      /escalated to big as advisor \(stalled: outcome_repeat os\.fs\.read 3×\)/,
    );
  });

  it("does nothing automatically when escalation is not turned on", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 6; i += 1) sameStep(options.eventHook, i);
      return done();
    });
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, auto: false }, pricing: PRICING },
    });
    expect(h.calls).toEqual([]);
  });

  it("does not make a call whose worst case is over the escalation cap", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, maxUsd: 0.000001 }, pricing: PRICING },
    });
    expect(h.calls).toEqual([]);
    expect(row!.notes?.join("\n")).toMatch(/over the escalation cap/);
  });

  it("counts the escalation in the turn's spend and stops escalating once the cap is reached", async () => {
    const spent: number[] = [];
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
      onEscalationSpend: (_t, usd) => spent.push(usd),
    });
    expect(spent[0]).toBeCloseTo(0.0018);

    const capped = harness(async (_s, options) => {
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    await runWorkerTasks(capped.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
      // The task itself was allowed to start; the cap is reached by then.
      shouldStart: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return undefined;
          }
          return "the spend cap for this turn is reached";
        };
      })(),
    });
    expect(capped.calls).toEqual([]);
  });

  it("re-runs the task on the escalation model only behind the replace flag", async () => {
    const providers: string[] = [];
    const h = harness(async (_s, options) => {
      providers.push(options.providerId ?? "");
      if (options.providerId === "cloud") return done();
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      for (let i = 3; i < 6; i += 1) sameStep(options.eventHook, i);
      // The replace abort lands here.
      return {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: options.signal?.aborted ? "cancelled" : "reply",
        stepCount: 6,
      } as RunTurnResult;
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, replace: true }, pricing: PRICING },
    });
    expect(providers).toEqual(["local", "cloud"]);
    expect(row!.status).toBe("ok");
    expect(row!.notes?.join("\n")).toMatch(/re-run on big after the local worker stayed stuck/);
  });
});

describe("the re-run's money is counted once (ATO-1319)", () => {
  it("keeps the local attempt's usage on the row and counts the re-run as escalation spend", async () => {
    const completed = (
      hook: TurnOptions["eventHook"],
      promptTokens: number,
      completionTokens: number,
    ): void =>
      hook?.({
        type: "llm_event",
        event: {
          type: "llm_completed",
          completion: {
            content: "",
            usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
          },
        },
      } as never);
    const h = harness(async (_s, options) => {
      if (options.providerId === "cloud") {
        completed(options.eventHook, 10_000, 1_000);
        return done();
      }
      completed(options.eventHook, 100, 10);
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      for (let i = 3; i < 6; i += 1) sameStep(options.eventHook, i);
      return {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: options.signal?.aborted ? "cancelled" : "reply",
        stepCount: 6,
      } as RunTurnResult;
    });
    const escalationSpend: number[] = [];
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, replace: true, maxUsd: 10 }, pricing: PRICING },
      onEscalationSpend: (_t, usd) => escalationSpend.push(usd),
    });
    expect(row!.usage?.promptTokens).toBe(100);
    expect(row!.usage?.completionTokens).toBe(10);
    // advisor call(s) plus the re-run's one completion, each counted once
    expect(escalationSpend.some((usd) => Math.abs(usd - (10_000 * 1 + 1_000 * 4) / 1e6) < 1e-9)).toBe(true);
  });
});

describe("the re-run's side effects reach the checkpoint at once (ATO-1316)", () => {
  it("reports the re-run's tool calls as they start", async () => {
    const h = harness(async (_s, options) => {
      if (options.providerId === "cloud") {
        options.eventHook?.({
          type: "llm_event",
          event: { type: "tool_call_parsed", call: { tool: "os.shell.run", args: {} } },
        } as never);
        return done();
      }
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      for (let i = 3; i < 6; i += 1) sameStep(options.eventHook, i);
      return {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: options.signal?.aborted ? "cancelled" : "reply",
        stepCount: 6,
      } as RunTurnResult;
    });
    const tools: Array<[string, string]> = [];
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, replace: true }, pricing: PRICING },
      onWorkerTool: (taskId, tool) => tools.push([taskId, tool]),
    });
    expect(tools).toContainEqual(["t0", "os.shell.run"]);
  });
});

describe("the person's stop and escalate on one worker (ATO-66)", () => {
  it("escalates a running worker on request and stops it alone", async () => {
    const live = new FusionLiveWorkers();
    let release!: () => void;
    const h = harness(
      (_s, options) =>
        new Promise<RunTurnResult>((resolve) => {
          release = () => resolve(done());
          options.signal?.addEventListener("abort", () =>
            resolve({ ...done(), reason: "cancelled" } as RunTurnResult),
          );
        }),
      { liveWorkers: live },
    );
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, auto: false }, pricing: PRICING },
    });
    await flush();
    expect(live.running("s-parent")).toEqual(["t0"]);
    const line = await live.escalate("s-parent", "t0");
    expect(line).toMatch(/escalated to big as advisor \(the person asked for it\)/);
    expect(h.calls).toEqual(["cloud"]);
    expect(live.stop("s-parent", "t0")).toBe(true);
    const [row] = await run;
    void release;
    expect(row!.status).toBe("cancelled");
    expect(row!.notes).toContain("stopped by the person");
    expect(live.running("s-parent")).toEqual([]);
    expect(live.stop("s-parent", "t0")).toBe(false);
  });

  it("cannot escalate without a configured target", async () => {
    const live = new FusionLiveWorkers();
    const h = harness(
      (_s, options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.signal?.addEventListener("abort", () =>
            resolve({ ...done(), reason: "cancelled" } as RunTurnResult),
          );
        }),
      { liveWorkers: live },
    );
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    await flush();
    expect(await live.escalate("s-parent", "t0")).toMatch(/no configured model/);
    live.stop("s-parent", "t0");
    await run;
    expect(h.calls).toEqual([]);
  });
});

describe("the advisor sees the worker's evidence and is asked for one edit (k8h)", () => {
  function executed(tool: string, status: "ok" | "error", summary: string, details: Record<string, unknown>) {
    return {
      type: "llm_event",
      event: { type: "tool_call_executed", result: { tool, status, summary, details } },
    } as never;
  }

  it("the advisor prompt carries the failing run's output and the file lines the worker kept re-reading", async () => {
    const prompts: string[] = [];
    const logs: Array<[string, unknown]> = [];
    const h = harness(
      async (_s, options) => {
        const hook = options.eventHook;
        hook?.(executed("os.fs.write", "ok", "wrote ark/formel.py", { path: "/repo/ark/formel.py" }));
        hook?.(executed("os.fs.read", "ok", "35| _TOKEN = re.compile(r'|(',')')", { path: "/repo/ark/formel.py" }));
        hook?.(
          executed("os.shell.run", "error", "key: TypeError: unsupported operand type(s) for &: 'str' and 'int'", {
            exitCode: 1,
          }),
        );
        for (let i = 0; i < 6; i += 1) sameStep(hook, i);
        await flush();
        return done();
      },
      {
        escalationComplete: async ({ prompt }) => {
          prompts.push(prompt);
          return {
            content: "ark/formel.py:35: replace r'|(',')' with r'|(,)' in one os.fs.edit.",
            usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
          };
        },
        logger: { info: (message: string, context?: unknown) => logs.push([message, context]) },
      },
    );
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Evidence: its own runs and reads");
    expect(prompts[0]).toContain("TypeError: unsupported operand type(s) for &");
    expect(prompts[0]).toContain("r'|(',')'");
    expect(logs).toContainEqual([
      "fusion: advisor hint",
      expect.objectContaining({ taskId: "t0", hint: expect.stringContaining("formel.py:35") }),
    ]);
  });

  it("the advisor prompt asks for one targeted edit and forbids a whole-file rewrite", () => {
    const prompt = renderAdvisorPrompt({
      brief: "write ark/formel.py",
      trigger: { kind: "stall", detail: "same result 3×" },
      findings: "4 tool calls",
    });
    expect(prompt).toMatch(/file:line/);
    expect(prompt).toMatch(/one os\.fs\.edit/);
    expect(prompt).toMatch(/Never tell it to rewrite or re-create a file/);
    expect(prompt).not.toMatch(/which file to write/);
    expect(prompt).toContain("(none recorded");
  });

  it("the advisor prompt shows the task's checks that still fail, before the worker's own runs (k8an)", () => {
    // k8an: the advisor saw only the worker's passing runs and answered
    // "No defect is visible" while the check failed on the worker's test.
    const checks = "1 of 3 failed on the runtime's last run of them:\n- `pytest -q tests`: AssertionError: assert 'Z' == 'a'";
    const prompt = renderAdvisorPrompt({
      brief: "write ark/formel.py",
      trigger: { kind: "stall", detail: "same result 3×" },
      findings: "4 tool calls",
      evidence: "$ python -c 'import ark'\nok",
      checks,
    });
    const heading = "## The task's checks, run by the runtime: still failing";
    expect(prompt).toContain(heading);
    expect(prompt).toContain("AssertionError: assert 'Z' == 'a'");
    expect(prompt.indexOf(heading)).toBeLessThan(prompt.indexOf("## Evidence: its own runs and reads"));
    for (const blank of [undefined, "  \n"]) {
      const without = renderAdvisorPrompt({
        brief: "b",
        trigger: { kind: "stall", detail: "d" },
        findings: "f",
        ...(blank === undefined ? {} : { checks: blank }),
      });
      expect(without).not.toContain(heading);
    }
  });

  it("asks for a design when a run passes slowly again after the worker changed its files (k8o)", async () => {
    // k8o: 10.47 s against a 10 s limit; ~250 s alone on speeding up the
    // design the brief prescribed, with no advisor asked.
    const run = (ms: number) =>
      executed("os.shell.run", "ok", `chain Z99: 2574.0 elapsed ${ms / 1000}s`, { exitCode: 0, durationMs: ms });
    const prompts: string[] = [];
    const advised = (fast: boolean) =>
      harness(
        async (_s, options) => {
          const hook = options.eventHook;
          hook?.(run(fast ? 2_900 : 10_470));
          hook?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as AgentLoopEvent);
          hook?.(executed("os.fs.edit", "ok", "edited", { path: "/repo/ark/ark.py" }));
          hook?.(run(fast ? 2_800 : 9_800));
          await flush();
          return done();
        },
        {
          escalationComplete: async ({ prompt }) => {
            prompts.push(prompt);
            return {
              content: "ark/ark.py:131: recompute only the cells that depend on the changed one.",
              usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
            };
          },
        },
      );
    const quick = advised(true);
    await runWorkerTasks(quick.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(prompts).toEqual([]);

    const slow = advised(false);
    const [row] = await runWorkerTasks(slow.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("passes but too slow: a run passed in 9.8 s");
    expect(prompts[0]).toContain("the defect is the design");
    expect(prompts[0]).toContain("### Last run (passed, 9.8 s)");
    expect(row!.notes?.join("\n")).toMatch(/escalated to big as advisor \(passes but too slow/);
  });

  it("steers a worker whose failing run ends in another task's file instead of asking the advisor (k8o)", async () => {
    // k8o: the tests worker's run failed inside the core worker's
    // ark/ark.py; the advisor it asked sent it to edit that file.
    const ROOT = resolve("/repo-k8o");
    const tasks: DelegateTask[] = [
      { id: "kerne", title: "Core", instructions: "write ark/ark.py", files: ["ark/ark.py"] },
      { id: "rest", title: "Rest", instructions: "write test_ark.py", files: ["test_ark.py"] },
    ];
    const traceback = (innermost: string) =>
      [
        "Traceback (most recent call last):",
        `  File "${resolve(ROOT, "test_ark.py")}", line 3, in <module>`,
        `  File "${innermost}", line 131, in _recompute`,
        "TypeError: 'NoneType' object is not iterable",
      ].join("\n");
    const scenario = (innermost: string) => {
      const logs: Array<[string, unknown]> = [];
      const h = harness(
        async (session, options) => {
          const meta = session.metadata?.fusionWorker as { taskId?: string } | undefined;
          if (meta?.taskId !== "rest") return done();
          const hook = options.eventHook;
          hook?.(executed("os.fs.write", "ok", "wrote test_ark.py", { path: resolve(ROOT, "test_ark.py") }));
          hook?.(executed("os.shell.run", "error", traceback(innermost), { exitCode: 1 }));
          for (let i = 0; i < 6; i += 1) sameStep(hook, i);
          await flush();
          return done();
        },
        {
          workingDir: ROOT,
          logger: { info: (message: string, context?: unknown) => logs.push([message, context]) },
        },
      );
      return { h, logs };
    };

    const foreign = scenario(resolve(ROOT, "ark", "ark.py"));
    await runWorkerTasks(foreign.h.deps, {
      ...BASE,
      maxWorkers: 2,
      tasks,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(foreign.h.calls).toEqual([]);
    expect(foreign.h.steers.filter((s) => s.includes('which task "kerne" writes'))).toHaveLength(1);
    expect(foreign.logs).toContainEqual([
      "fusion: worker steered off another task's file",
      expect.objectContaining({ taskId: "rest", owner: "kerne" }),
    ]);

    const own = scenario(resolve(ROOT, "test_ark.py"));
    await runWorkerTasks(own.h.deps, {
      ...BASE,
      maxWorkers: 2,
      tasks,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(own.h.calls).toEqual(["cloud"]);
  });

  it("steers a worker that re-reads a module before running anything, once (k8p)", async () => {
    // k8p: the judge's retry worker read formel.py six times before its
    // first run; the advisor could only say it had run nothing yet.
    const read = (path: string) => executed("os.fs.read", "ok", "read", { path });
    const scenario = (first: "run" | "read", path = "/repo/ark/formel.py") => {
      const h = harness(async (_s, options) => {
        const hook = options.eventHook;
        if (first === "run") hook?.(executed("os.shell.run", "error", "Traceback", { exitCode: 1 }));
        hook?.(read(path));
        hook?.(read("/repo/ark/ark.py"));
        hook?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as AgentLoopEvent);
        hook?.(read(path));
        hook?.(read(path));
        await flush();
        return done();
      });
      return h;
    };
    const never = scenario("read");
    await runWorkerTasks(never.deps, { ...BASE, tasks: TASK, signal: new AbortController().signal });
    expect(never.steers.filter((s) => s.includes("have run nothing yet"))).toEqual([
      expect.stringContaining("/repo/ark/formel.py again"),
    ]);

    const ran = scenario("run");
    await runWorkerTasks(ran.deps, { ...BASE, tasks: TASK, signal: new AbortController().signal });
    expect(ran.steers.filter((s) => s.includes("run nothing yet"))).toEqual([]);

    const notes = scenario("read", "/repo/NOTES.md");
    await runWorkerTasks(notes.deps, { ...BASE, tasks: TASK, signal: new AbortController().signal });
    expect(notes.steers.filter((s) => s.includes("run nothing yet"))).toEqual([]);
  });

  it("asks no advisor with too little of the worker's time left to use the hint", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 6; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: [{ ...TASK[0]!, timeoutMs: 60_000 }],
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(h.calls).toEqual([]);
  });

  it("the advisor prompt for a slow pass asks for the design change", () => {
    const prompt = renderAdvisorPrompt({
      brief: "write ark/ark.py; the 2574-cell chain under 10 s",
      trigger: { kind: "slow-pass", detail: "a run passed in 9.8 s" },
      findings: "4 tool calls",
    });
    expect(prompt).toContain("passes but too slow: a run passed in 9.8 s");
    expect(prompt).toMatch(/smallest change that meets the limit/);
    const stall = renderAdvisorPrompt({
      brief: "b",
      trigger: { kind: "stall", detail: "same result 3×" },
      findings: "f",
    });
    expect(stall).not.toMatch(/the defect is the design/);
  });
});
