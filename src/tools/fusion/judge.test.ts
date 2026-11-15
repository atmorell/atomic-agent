import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import {
  buildAcceptanceChecklist,
  gatherEvidence,
  JUDGE_EVIDENCE_CHARS,
  JUDGE_REQUEST_CHARS,
  JUDGE_RUN_CHARS,
  judgeTask,
  parseJudgeAnswer,
  renderRuntimeRecord,
  shareEvidenceBudget,
  type AcceptanceItem,
} from "./judge.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import type { EscalationComplete } from "./escalation.js";
import type { DelegateTask } from "./delegate-args.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const TARGET = { providerId: "cloud", model: "judge-model" };

function answer(items: Array<{ id: string; pass: unknown; why?: string }>): EscalationComplete {
  return async () => ({ content: JSON.stringify({ items }) });
}

describe("judge evidence budget (ap3g)", () => {
  it("shows small files whole and splits what is left between the large ones", () => {
    expect(shareEvidenceBudget([100, 11_000, 50_000], 24_000)).toEqual([100, 11_000, 12_900]);
    expect(shareEvidenceBudget([30_000, 30_000], 24_000)).toEqual([12_000, 12_000]);
    expect(shareEvidenceBudget([], 24_000)).toEqual([]);
  });

  it("shows a one-file task's 12 000-char test file whole, not its first 6 000 chars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-evidence-"));
    const body = `def test_end():\n    assert True\n`.padStart(12_000, "#");
    writeFileSync(join(dir, "test_opg.py"), body);
    const task: DelegateTask = { id: "test", title: "tests", instructions: "write tests", files: ["test_opg.py"] };
    const evidence = await gatherEvidence(task, undefined, "done", dir);
    expect(evidence).toContain("def test_end():");
    expect(evidence).not.toContain("clipped");
    expect(evidence.length).toBeLessThanOrEqual(JUDGE_EVIDENCE_CHARS + 100);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("acceptance checklist (ATO-944)", () => {
  it("lists the task's checks, provides, files, deliverable and instructions", () => {
    const task: DelegateTask = {
      id: "ui",
      title: "UI",
      instructions: "Build the HUD",
      deliverable: "a HUD showing score",
      files: ["hud.js"],
    };
    const items = buildAcceptanceChecklist(task, {
      checks: [{ task: "ui", command: "node test.js" }, { task: "other", command: "x" }],
      provides: [{ task: "ui", kind: "symbol", name: "HUD.draw", in: "hud.js", shape: "(ctx) => void" }],
    });
    expect(items.map((i) => i.kind)).toEqual([
      "check",
      "provide",
      "file",
      "deliverable",
      "instructions",
    ]);
    expect(items[0]!.checkIndex).toBe(0);
    expect(items[1]!.judged).toBe(true);
  });

  it("adds the original request's item last, and only when there is a request (ap3b)", () => {
    const task: DelegateTask = { id: "t", title: "T", instructions: "write cli.py" };
    expect(buildAcceptanceChecklist(task, undefined).map((i) => i.kind)).toEqual(["instructions"]);
    expect(buildAcceptanceChecklist(task, undefined, "  ").map((i) => i.kind)).toEqual(["instructions"]);
    const items = buildAcceptanceChecklist(task, undefined, 'print "Tilfoejet <id>"');
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["a1", "instructions"],
      ["a2", "request"],
    ]);
    expect(items[1]!.judged).toBe(true);
    expect(items[1]!.text).toContain("verbatim");
  });
});

describe("the judge reads the user's original request (ap3b, 15-11-2026)", () => {
  it("shows the request before the brief, only when there is one, cut at JUDGE_REQUEST_CHARS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-req-"));
    writeFileSync(join(dir, "cli.py"), 'print(f"Tilføjet {ny.id}")');
    const task: DelegateTask = { id: "t", title: "T", instructions: "write the CLI", files: ["cli.py"] };
    const request = 'Build a todo app. `add` prints exactly "Tilfoejet <id>: <tekst>".';
    const prompts: string[] = [];
    const base = {
      task,
      items: buildAcceptanceChecklist(task, undefined, request),
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: (async (call) => {
        prompts.push(call.prompt);
        return { content: '{"items":[{"id":"a2","pass":true,"why":"ok"},{"id":"a3","pass":false,"why":"Tilføjet, not Tilfoejet"}]}' };
      }) as EscalationComplete,
      signal: new AbortController().signal,
    };
    const verdict = await judgeTask({ ...base, originalRequest: request });
    await judgeTask({ ...base, items: buildAcceptanceChecklist(task, undefined) });
    await judgeTask({ ...base, originalRequest: `${"x".repeat(JUDGE_REQUEST_CHARS)}TAIL` });
    expect(prompts[0]).toContain("## The user's original request (this task is one part of it)");
    expect(prompts[0]).toContain(request);
    expect(prompts[0]).toContain("character for character");
    expect(prompts[0]!.indexOf("## The user's original request")).toBeLessThan(
      prompts[0]!.indexOf("## Task"),
    );
    expect(prompts[0]).toMatch(/- a3: every exact name, message, output line/);
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((i) => i.id === "a3")).toMatchObject({ pass: false, by: "judge" });
    expect(prompts[1]).not.toContain("original request");
    expect(prompts[2]).toContain("[…]");
    expect(prompts[2]).not.toContain("TAIL");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the judge cannot pass what the facts fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-"));
  const task: DelegateTask = { id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"] };
  const items = buildAcceptanceChecklist(task, undefined);

  it("keeps a missing file red and does not pay the judge for it", async () => {
    let called = 0;
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "Done! I wrote a.txt.",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: async () => {
        called += 1;
        return { content: '{"items":[{"id":"a2","pass":true}]}' };
      },
      signal: new AbortController().signal,
    });
    expect(called).toBe(0);
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((v) => v.id === "a1")).toMatchObject({ pass: false, why: "missing" });
  });

  it("reads only a literal true as a pass, and an item without a verdict as red", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const both: AcceptanceItem[] = [
      ...items,
      { id: "a3", kind: "deliverable", text: "x", judged: true },
    ];
    const verdict = await judgeTask({
      task,
      items: both,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: answer([{ id: "a2", pass: "yes" }]),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((v) => v.id === "a2")?.pass).toBe(false);
    expect(verdict.items.find((v) => v.id === "a3")?.why).toBe("the judge gave no verdict");
  });

  it("leaves a task unverified, never green, when the answer cannot be read", async () => {
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: async () => ({ content: "Looks great to me!" }),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(false);
    expect(verdict.unverified).toMatch(/could not be read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a JSON answer wrapped in prose", () => {
    const parsed = parseJudgeAnswer('Here: {"items":[{"id":"a1","pass":true,"why":"ok"}]} done');
    expect(parsed?.get("a1")).toEqual({ pass: true, why: "ok" });
  });
});

describe("the judge reads the runtime's record of the run (ap2c, 15-11-2026)", () => {
  const RUN = {
    lines: ["python -m pytest -q"],
    cwd: "/w",
    exitCode: 0,
    timedOut: false,
    durationMs: 900,
    stdoutTail: "....\n36 passed in 0.40s\n",
    changedAfter: false,
  };

  it("shows the last command, its exit and stdout, and the written files relative to the folder", () => {
    const dir = join(tmpdir(), "rec");
    const text = renderRuntimeRecord(
      { run: RUN, written: [join(dir, "tests", "test_regn.py"), join(tmpdir(), "elsewhere.txt")] },
      dir,
    );
    expect(text).toContain("## Recorded by the runtime (facts, not the worker's words)");
    expect(text).toContain("files written by the file tools: tests/test_regn.py, ");
    expect(text).toContain(join(tmpdir(), "elsewhere.txt"));
    expect(text).toContain("last command run: `python -m pytest -q` — exit 0");
    expect(text).toContain("36 passed in 0.40s");
  });

  it("says plainly when no command reached its exit and nothing was written", () => {
    const text = renderRuntimeRecord({ run: undefined, written: [] }, tmpdir());
    expect(text).toContain("files written by the file tools: none");
    expect(text).toContain("last command run: none that reached its exit");
  });

  it("keeps the end of a long stdout and flags a timeout", () => {
    const text = renderRuntimeRecord(
      { run: { ...RUN, timedOut: true, stdoutTail: `${"x".repeat(5_000)}END` }, written: [] },
      tmpdir(),
    );
    expect(text).toContain("exit 0, timed out");
    expect(text).toContain("[…]");
    expect(text).toContain("END");
    expect(text.length).toBeLessThan(JUDGE_RUN_CHARS + 400);
  });

  it("puts the record in the judge's prompt only when there is one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-r-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const task: DelegateTask = {
      id: "t",
      title: "T",
      instructions: "write a.txt, then run python -m pytest -q and report the result",
      files: ["a.txt"],
    };
    const prompts: string[] = [];
    const base = {
      task,
      items: buildAcceptanceChecklist(task, undefined),
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: (async (call) => {
        prompts.push(call.prompt);
        return { content: '{"items":[{"id":"a2","pass":true,"why":"ok"}]}' };
      }) as EscalationComplete,
      signal: new AbortController().signal,
    };
    await judgeTask(base);
    await judgeTask({ ...base, record: { run: RUN, written: [join(dir, "a.txt")] } });
    expect(prompts[0]).not.toContain("Recorded by the runtime");
    expect(prompts[1]).toContain("shown by the runtime's record");
    expect(prompts[1]).toContain("files written by the file tools: a.txt");
    expect(prompts[1]).toContain("36 passed");
    expect(prompts[1]!.indexOf("## Evidence")).toBeLessThan(
      prompts[1]!.indexOf("## Recorded by the runtime"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    judge: TARGET,
    ...over,
  };
}

function deps(
  dir: string,
  complete: EscalationComplete,
  over: Partial<FusionDelegateDeps> = {},
): FusionDelegateDeps & { briefs: string[] } {
  let minted = 0;
  const d = {
    briefs: [] as string[],
    runTurn: async (_s: unknown, message: string) => {
      d.briefs.push(message);
      writeFileSync(join(dir, "a.txt"), `attempt ${d.briefs.length}`);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: dir,
        metadata: { fusionWorker: { ...(meta as object) } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: complete,
    ...over,
  } as FusionDelegateDeps & { briefs: string[] };
  return d;
}

const TASK = [{ id: "t", title: "T", instructions: "write a.txt with the score", files: ["a.txt"] }];

describe("a node closes only on a green list (ATO-944)", () => {
  it("puts the list in the brief, re-runs a red task once with the findings, and fails it honestly if still red", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-d-"));
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return { content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "no score in a.txt" }] }) };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(d.briefs).toHaveLength(2);
    expect(d.briefs[0]).toContain("ACCEPTANCE CHECKLIST (read-only)");
    expect(d.briefs[1]).toContain("[a2] the task is done as instructed: write a.txt with the score — no score in a.txt");
    expect(judged).toBe(2);
    const row = (result.details.tasks as Array<{ status: string; error?: string }>)[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^judge: 1 of 2 acceptance items not met after one retry — a2 no score in a\.txt/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs each round's verdict with its red items, the only record of why a task was sent back (ap3e)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-log-"));
    const records: LogRecord[] = [];
    const d = deps(
      dir,
      async () => ({ content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "no score in a.txt" }] }) }),
      { logger: new StructuredLogger({ level: "info", sinks: [(r) => records.push(r)] }) },
    );
    await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const verdicts = records.filter((r) => r.message === "fusion: judge verdict").map((r) => r.context);
    expect(verdicts).toEqual([
      expect.objectContaining({ taskId: "t", round: "first", green: false, red: ["a2 no score in a.txt"] }),
      expect.objectContaining({ taskId: "t", round: "retry", green: false, red: ["a2 no score in a.txt"] }),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the delegating session on every judge call, for its spend readout (ATO-1388)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-sid-"));
    const sessions: Array<string | undefined> = [];
    const d = deps(dir, async (call) => {
      sessions.push(call.sessionId);
      return { content: JSON.stringify({ items: [{ id: "a2", pass: true, why: "ok" }] }) };
    });
    await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((id) => id === "s-p")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the judge and the brief's list the session's original request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-oreq-"));
    const prompts: string[] = [];
    const d = deps(
      dir,
      async (call) => {
        prompts.push(call.prompt);
        return {
          content: JSON.stringify({
            items: [
              { id: "a2", pass: true, why: "ok" },
              { id: "a3", pass: true, why: "ok" },
            ],
          }),
        };
      },
      { resolveOriginalRequest: () => 'Write a.txt; the score line reads "Point: <n>".' },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(d.briefs[0]).toContain("[a3] every exact name, message, output line");
    expect(prompts[0]).toContain('the score line reads "Point: <n>"');
    const row = (result.details.tasks as Array<{ status: string }>)[0]!;
    expect(row.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes a task the retry fixed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-g-"));
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return {
        content: JSON.stringify({
          items: [{ id: "a2", pass: judged > 1, why: judged > 1 ? "score present" : "missing score" }],
        }),
      };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    expect(row.status).toBe("ok");
    expect(row.notes?.join(" ")).toContain("judge: all 2 acceptance items green after one retry");
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the judge each attempt's runtime record: the retry's run, both attempts' writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-rec-"));
    const prompts: string[] = [];
    const d = deps(dir, async (call) => {
      prompts.push(call.prompt);
      return {
        content: JSON.stringify({
          items: [{ id: "a2", pass: prompts.length > 1, why: "see record" }],
        }),
      };
    });
    let runs = 0;
    d.runTurn = async (_session, _message, options) => {
      runs += 1;
      const file = runs === 1 ? "a.txt" : "b.txt";
      writeFileSync(join(dir, file), `attempt ${runs}`);
      const executed = (result: Record<string, unknown>): void =>
        options.eventHook?.({
          type: "llm_event",
          event: { type: "tool_call_executed", result, batchIndex: 0, batchSize: 1 } as never,
        });
      executed({
        tool: "os.fs.write",
        status: "ok",
        summary: `wrote ${file}`,
        details: { path: join(dir, file) },
        truncated: false,
      });
      if (runs === 2) {
        const text = "$ python -m pytest -q\nexit: 0\n36 passed in 0.40s";
        executed({
          tool: "os.shell.run",
          status: "ok",
          summary: text,
          fullOutput: text,
          details: {
            cmd: "python",
            args: ["-m", "pytest", "-q"],
            rawArgs: ["-m", "pytest", "-q"],
            cwd: dir,
            shell: false,
            exitCode: 0,
            durationMs: 900,
            timedOut: false,
            truncated: false,
            outputStreams: "stdout",
          },
          truncated: false,
        });
      }
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("files written by the file tools: a.txt");
    expect(prompts[0]).toContain("last command run: none that reached its exit");
    expect(prompts[1]).toContain("files written by the file tools: a.txt, b.txt");
    expect(prompts[1]).toContain("last command run: `python -m pytest -q` — exit 0");
    expect(prompts[1]).toContain("36 passed in 0.40s");
    const row = (result.details.tasks as Array<{ status: string }>)[0]!;
    expect(row.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the retry of a task with no files split it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-s-"));
    const proposal =
      "Too big.\n```split_proposal\n" +
      JSON.stringify({
        tasks: [
          { id: "a", title: "A", instructions: "research part a" },
          { id: "b", title: "B", instructions: "research part b" },
        ],
      }) +
      "\n```";
    let judged = 0;
    const briefs: string[] = [];
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return {
          content: JSON.stringify({
            items: [{ id: "a1", pass: judged > 1, why: judged > 1 ? "covered" : "too thin" }],
          }),
        };
      },
      { resolveRunMode: () => mode({ taskTree: { maxDepth: 2, maxNodes: 24 } }) },
    );
    d.runTurn = async (_session, message, options) => {
      briefs.push(message);
      const text = message.includes("research part")
        ? "part done"
        : briefs.length === 1
          ? "thin answer"
          : proposal;
      options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text } });
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "t", title: "T", instructions: "research the market" }] },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(briefs[1]).toContain("If this task is too big");
    expect(result.details.taskTree).toMatchObject({ splits: 1 });
    const row = (result.details.tasks as Array<{ status: string; reply: string }>)[0]!;
    expect(row.reply).toContain("[t/a] ok");
    expect(row.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the status of a retry that ended without being judged (stopped by the person)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-c-"));
    let runs = 0;
    const d = deps(dir, async () => ({
      content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "no score" }] }),
    }));
    d.runTurn = async () => {
      runs += 1;
      writeFileSync(join(dir, "a.txt"), `attempt ${runs}`);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: runs === 1 ? "reply" : "cancelled",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const row = (
      result.details.tasks as Array<{
        status: string;
        notes?: string[];
        judge?: { green: boolean; failed: number; retried: boolean };
      }>
    )[0]!;
    expect(row.status).toBe("cancelled");
    expect(row.notes?.join(" ")).toMatch(/the retry ended cancelled and was not judged/);
    // The first verdict's findings stay visible: which item, and why (ap1d).
    expect(row.notes?.join(" ")).toContain("— a2 no score;");
    expect(row.judge).toMatchObject({ green: false, failed: 1, retried: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes nothing when the judge is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-o-"));
    let judged = 0;
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return { content: "{}" };
      },
      { resolveRunMode: () => mode({ judge: null }) },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(judged).toBe(0);
    expect(d.briefs).toHaveLength(1);
    expect(d.briefs[0]).not.toContain("ACCEPTANCE CHECKLIST");
    expect((result.details.tasks as Array<{ status: string }>)[0]!.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });
});
