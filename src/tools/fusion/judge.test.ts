import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { REVIEWED_NOTE } from "./reviewed-note.js";
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
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_REQUEST_CHARS,
  JUDGE_EARLIER_RUN_CHARS,
  JUDGE_RUN_CHARS,
  JUDGE_RULES,
  JUDGE_SEVERITY_RULE,
  JUDGE_WHOLE_FILE_CHARS,
  gatherJudgeEvidence,
  judgeTask,
  judgeTasks,
  parseJudgeAnswer,
  renderJudgeCallPrompt,
  renderJudgePrompt,
  renderRetryFindings,
  renderRuntimeRecord,
  scopeOnlyRed,
  shareEvidenceBudget,
  type AcceptanceItem,
  type JudgeVerdict,
  type JudgeSession,
} from "./judge.js";
import { JUDGE_FIXED_PART_END } from "../../llm/provider/subscription-cli/cli-session-chain.js";
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
    expect(prompts[1]).not.toContain("## The user's original request");
    expect(prompts[2]).toContain("[…]");
    expect(prompts[2]).not.toContain("TAIL");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the judge fails defects, not taste (ap3h, 15-11-2026)", () => {
  it("tells the judge every time, right after its role, to pass an item that is only style", () => {
    const task: DelegateTask = { id: "t", title: "T", instructions: "write a.py with why comments", files: ["a.py"] };
    const prompt = renderJudgePrompt({
      task,
      items: buildAcceptanceChecklist(task, undefined),
      facts: [],
      evidence: "a.py: def f(): pass",
    });
    expect(prompt).toContain(JUDGE_SEVERITY_RULE);
    expect(prompt.indexOf(JUDGE_SEVERITY_RULE)).toBeLessThan(prompt.indexOf("## Task"));
    expect(JUDGE_SEVERITY_RULE).toContain("asserts the wrong thing");
    expect(JUDGE_SEVERITY_RULE).toContain("even when the task's wording asks for it");
    expect(JUDGE_SEVERITY_RULE).toContain("pass the item");
  });
});

describe("the judge names every defect in its first round (k3b, 16-11-2026)", () => {
  it("asks for all of a red item's defects, since the worker gets one retry", () => {
    const task: DelegateTask = { id: "t", title: "T", instructions: "write cli.py", files: ["cli.py"] };
    const prompt = renderJudgePrompt({
      task,
      items: buildAcceptanceChecklist(task, undefined),
      facts: [],
      evidence: "cli.py: print('Tilføjet')",
    });
    const answer = prompt.slice(
      prompt.lastIndexOf("Answer with JSON only"),
      prompt.indexOf(JUDGE_FIXED_PART_END),
    );
    expect(answer).toContain("every defect in this item, joined by '; '");
    expect(answer).toContain("Name all of a red item's defects now");
    expect(answer).toContain('another item that fails for the same defect says only "same as <id>"');
    expect(answer).not.toContain("what is wrong");
  });
});

describe("a red item needs a defect, and a retry is a repair (k8c, 16-11-2026)", () => {
  it("tells the judge an unrun check is not a defect by itself when the verify passed", () => {
    expect(JUDGE_RULES).toContain("is a means, not a deliverable");
    expect(JUDGE_RULES).toContain("when the runtime's verify passed, a check the worker did not run is not a defect by itself");
    expect(JUDGE_RULES).toContain("Rule red only for a defect the evidence shows in what the check was for");
  });

  it("bounds the retry to the named lines and one run of the verify", () => {
    const items: AcceptanceItem[] = [
      { id: "a5", kind: "instructions", text: "done as instructed", judged: true },
    ];
    const verdict: JudgeVerdict = {
      green: false,
      items: [{ id: "a5", pass: false, by: "judge", why: "vis crashes on an invalid cell" }],
      costUsd: null,
    };
    const brief = renderRetryFindings(items, verdict, {
      ok: true,
      exitCode: 0,
      command: "python -m pytest -q",
      excerpt: [],
    });
    expect(brief.split("\n")).toEqual([
      "## A judge found these acceptance items NOT met in your previous attempt",
      "- [a5] done as instructed — vis crashes on an invalid cell",
      "This is a repair, not a second attempt. The files from the previous attempt are on disk: edit only the lines these findings name, in files you own, and write no new file unless a finding asks for one. The task's other instructions are already done — do not repeat them or their self-tests. Run `python -m pytest -q` at most once, then reply.",
    ]);
    expect(renderRetryFindings(items, verdict)).toContain("Run the task's check at most once, then reply.");
  });
});

describe("the judge's prompt is built to be cached (k3c, 16-11-2026)", () => {
  it("opens every call with the same rules and puts the case after JUDGE_FIXED_PART_END", () => {
    const a: DelegateTask = { id: "a", title: "A", instructions: "write a.py", files: ["a.py"] };
    const b: DelegateTask = { id: "b", title: "B", instructions: "write b.py", files: ["b.py"] };
    const row = (task: DelegateTask) => ({ task, items: buildAcceptanceChecklist(task, undefined), facts: [] });
    const one = renderJudgeCallPrompt({ tasks: [row(a)], evidence: "e1", originalRequest: "build it" });
    const two = renderJudgeCallPrompt({
      tasks: [row(a), row(b)],
      evidence: "e2",
      originalRequest: "build them",
    });
    for (const prompt of [one, two]) {
      expect(prompt.slice(0, prompt.indexOf(JUDGE_FIXED_PART_END))).toBe(`${JUDGE_RULES}\n`);
    }
    expect(one.indexOf("## The user's original request")).toBeGreaterThan(
      one.indexOf(JUDGE_FIXED_PART_END),
    );
    expect(two).toContain("Workers say they finished the 2 tasks below, each one part of the same job. An item's id is <task>:<item>.");
    expect(JUDGE_RULES).toContain("An item that needs a change the evidence does not show is not met.");
    expect(JUDGE_RULES).not.toContain("${");
  });

  it("shows a new file whole, a large changed one as a diff and a large unchanged one by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-diff-"));
    const big = `${Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n")}\n`;
    const bigNow = big.replace("line 100 ", "line 100 CHANGED ");
    expect(big.length).toBeGreaterThan(JUDGE_WHOLE_FILE_CHARS);
    writeFileSync(join(dir, "big.py"), bigNow);
    writeFileSync(join(dir, "same.py"), big);
    writeFileSync(join(dir, "small.py"), "a = 1\n");
    writeFileSync(join(dir, "tiny.py"), "b = 2\n");
    writeFileSync(join(dir, "new.py"), "c = 3\n");
    writeFileSync(join(dir, "other.py"), "d = 4\n");
    const task: DelegateTask = {
      id: "t",
      title: "T",
      instructions: "edit",
      files: ["big.py", "same.py", "small.py", "tiny.py", "new.py", "other.py"],
    };
    const before = new Map<string, string | null>([
      ["big.py", big],
      ["same.py", big],
      ["small.py", "a = 0\n"],
      ["tiny.py", "b = 2\n"],
      ["new.py", null],
    ]);
    const { text, seen } = await gatherJudgeEvidence([{ task, reply: "" }], undefined, dir, { before });
    expect(text).toContain("### big.py (changed by this work: diff, 200 lines now)\n@@ -88,25 +88,25 @@\n");
    expect(text).toContain(`\n-line 100 ${"x".repeat(20)}\n+line 100 CHANGED ${"x".repeat(20)}\n`);
    expect(text).toContain("\n line 88 ");
    expect(text).not.toContain("line 87 ");
    expect(text).not.toContain("line 113 ");
    expect(text).toContain("### same.py — unchanged by this work (200 lines, not shown)");
    expect(text).toContain("### small.py (changed by this work, shown whole)\na = 1");
    expect(text).toContain("### tiny.py (unchanged by this work)\nb = 2");
    expect(text).toContain("### new.py (new file)\nc = 3");
    expect(text).toContain("### other.py\nd = 4");
    expect(text.length).toBeLessThan(bigNow.length);
    expect(seen.get("big.py")).toBe(bigNow);
    expect(await gatherJudgeEvidence([{ task, reply: "" }], undefined, dir, { before })).toHaveProperty(
      "clipped",
      false,
    );
    expect(seen.get("new.py")).toBe("c = 3\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("follows up on the round before in one session, with its <task>:<item> ids and only what changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-follow-"));
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, "c.txt"), "same\n");
    writeFileSync(join(dir, "b.txt"), "two\n");
    const t1: DelegateTask = { id: "t1", title: "1", instructions: "write a.txt and c.txt", files: ["a.txt", "c.txt"] };
    const t2: DelegateTask = { id: "t2", title: "2", instructions: "write b.txt", files: ["b.txt"] };
    const calls: Array<{ prompt: string; key: string | undefined }> = [];
    const answers = [
      '{"red":[{"id":"t1:a3","why":"wrong word"}],"pass":["t2:a2"]}',
      '{"red":[],"pass":["t1:a3"]}',
    ];
    const complete: EscalationComplete = async (call) => {
      calls.push({ prompt: call.prompt, key: call.cliSessionKey });
      return { content: answers[calls.length - 1]! };
    };
    const session: JudgeSession = { key: "judge-k" };
    const call = {
      facts: { checkOutcomes: [], findings: [] },
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete,
      signal: new AbortController().signal,
      before: new Map<string, string | null>([["a.txt", null], ["b.txt", null], ["c.txt", null]]),
      session,
    };
    const entry = (task: DelegateTask) => ({ task, items: buildAcceptanceChecklist(task, undefined), reply: "" });
    const first = await judgeTasks({ ...call, entries: [entry(t1), entry(t2)] });
    expect(first.get("t1")).toMatchObject({ green: false });
    writeFileSync(join(dir, "a.txt"), "uno\n");
    const second = await judgeTasks({ ...call, entries: [entry(t1)] });
    expect(second.get("t1")).toMatchObject({ green: true });
    expect(calls.map((c) => c.key)).toEqual(["judge-k", "judge-k"]);
    expect(calls[1]!.prompt.startsWith(`${calls[0]!.prompt}\n\n## Follow-up: the workers retried\n`)).toBe(true);
    const followUp = calls[1]!.prompt.slice(calls[0]!.prompt.length);
    expect(followUp).toContain("### Task t1\nYour findings, which the worker was told to fix:\n- t1:a3: wrong word");
    expect(followUp).toContain("- t1:a3: the task is done as instructed (its instructions are above)");
    expect(followUp).toContain("### a.txt (changed since your ruling, shown whole)\nuno");
    expect(followUp).toContain("### c.txt — unchanged since your ruling (1 line, not shown)");
    expect(followUp).not.toContain("b.txt");
    expect(followUp).not.toContain(JUDGE_RULES);
    expect([...session.last!.asked]).toEqual(["t1", "t2"]);
    expect(second.get("t1")).not.toHaveProperty("clipped");
    expect(session.last!.clipped).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a verdict on clipped evidence, and the follow-up round keeps the mark", async () => {
    // The reviewed line (`reviewed-note.ts`) is only true of files the
    // judge read whole; a round-2 ruling still rests on round 1's text.
    const dir = mkdtempSync(join(tmpdir(), "judge-clip-"));
    const big = `${"x = 1\n".repeat(5_000)}`;
    expect(big.length).toBeGreaterThan(JUDGE_EVIDENCE_CHARS);
    writeFileSync(join(dir, "big.py"), big);
    const task: DelegateTask = { id: "t", title: "T", instructions: "write big.py", files: ["big.py"] };
    const answers = ['{"red":[{"id":"a2","why":"wrong"}],"pass":[]}', '{"red":[],"pass":["a2"]}'];
    let n = 0;
    const session: JudgeSession = { key: "judge-clip" };
    const call = {
      facts: { checkOutcomes: [], findings: [] },
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: (async () => ({ content: answers[n++]! })) as EscalationComplete,
      signal: new AbortController().signal,
      before: new Map<string, string | null>([["big.py", null]]),
      session,
      entries: [{ task, items: buildAcceptanceChecklist(task, undefined), reply: "" }],
    };
    const evidence = await gatherJudgeEvidence(call.entries, undefined, dir, { before: call.before });
    expect(evidence.clipped).toBe(true);
    expect((await judgeTasks(call)).get("t")).toMatchObject({ green: false, clipped: true });
    writeFileSync(join(dir, "big.py"), big.replace("x = 1\n", "x = 2\n"));
    const second = (await judgeTasks(call)).get("t")!;
    expect(second).toMatchObject({ green: true, clipped: true });
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

  it("shows the command, its exit and stdout, and the written files relative to the folder", () => {
    const dir = join(tmpdir(), "rec");
    const text = renderRuntimeRecord(
      { runs: [RUN], written: [join(dir, "tests", "test_regn.py"), join(tmpdir(), "elsewhere.txt")] },
      dir,
    );
    expect(text).toContain("## Recorded by the runtime (facts, not the worker's words)");
    expect(text).toContain("files written by the file tools: tests/test_regn.py, ");
    expect(text).toContain(join(tmpdir(), "elsewhere.txt"));
    expect(text).toContain("1. `python -m pytest -q` — exit 0");
    expect(text).toContain("36 passed in 0.40s");
  });

  it("says plainly when no command reached its exit and nothing was written", () => {
    const text = renderRuntimeRecord({ runs: [], written: [] }, tmpdir());
    expect(text).toContain("files written by the file tools: none");
    expect(text).toContain("commands run: none that reached its exit");
  });

  it("shows an earlier pytest run before a later line count (ap3i, 15-11-2026)", () => {
    const count = {
      ...RUN,
      lines: ["wc -l tests/test_lager.py"],
      stdoutTail: "212 tests/test_lager.py\n",
    };
    const early = { ...RUN, stdoutTail: `${"y".repeat(2_000)}\n22 passed in 0.31s\n` };
    const text = renderRuntimeRecord({ runs: [early, count], written: [] }, tmpdir());
    const pytest = text.indexOf("1. `python -m pytest -q` — exit 0");
    const wc = text.indexOf("2. `wc -l tests/test_lager.py` — exit 0");
    expect(pytest).toBeGreaterThan(-1);
    expect(wc).toBeGreaterThan(pytest);
    expect(text).toContain("22 passed in 0.31s");
    expect(text).toContain("212 tests/test_lager.py");
    // An earlier run keeps only a short tail: room for the summary line.
    expect(text.slice(pytest, wc).length).toBeLessThan(JUDGE_EARLIER_RUN_CHARS + 200);
  });

  it("keeps the end of a long stdout and flags a timeout", () => {
    const text = renderRuntimeRecord(
      { runs: [{ ...RUN, timedOut: true, stdoutTail: `${"x".repeat(5_000)}END` }], written: [] },
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
    await judgeTask({ ...base, record: { runs: [RUN], written: [join(dir, "a.txt")] } });
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

  it("runs both rounds in one CLI session, the retry as a follow-up to the first (k3c, 16-11-2026)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-cli-"));
    const calls: Array<{ prompt: string; key: string | undefined; sid: string | undefined }> = [];
    const d = deps(dir, async (call) => {
      calls.push({ prompt: call.prompt, key: call.cliSessionKey, sid: call.sessionId });
      return { content: JSON.stringify({ red: [{ id: "a2", why: "no score in a.txt" }], pass: [] }) };
    });
    await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toMatch(/^judge-/);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls.every((c) => c.sid === "s-p")).toBe(true);
    expect(calls[0]!.prompt).toContain("### a.txt (new file)\nattempt 1");
    expect(
      calls[1]!.prompt.startsWith(`${calls[0]!.prompt}\n\n## Follow-up: the workers retried\n`),
    ).toBe(true);
    const followUp = calls[1]!.prompt.slice(calls[0]!.prompt.length);
    expect(followUp).toContain("Your findings, which the worker was told to fix:\n- a2: no score in a.txt");
    expect(followUp).toContain("### a.txt (changed since your ruling, shown whole)\nattempt 2");
    expect(followUp).not.toContain("write a.txt with the score");
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

  it("does not call a file the first attempt wrote unchanged because the retry left it (k3d, 16-11-2026)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-keep-"));
    let judged = 0;
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return { content: JSON.stringify({ items: [{ id: "a3", pass: judged > 1, why: "tests" }] }) };
      },
      {
        runTurn: async (_s: unknown, message: string) => {
          d.briefs.push(message);
          if (d.briefs.length === 1) writeFileSync(join(dir, "models.py"), "x = 1\n");
          // The retry starts well after the first attempt wrote models.py.
          else utimesSync(join(dir, "models.py"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
          writeFileSync(join(dir, "test_models.py"), `# attempt ${d.briefs.length}\n`);
          return {
            session: createEmptySessionState({ id: "s-w", workingDir: dir }),
            reason: "reply",
            stepCount: 1,
          } as RunTurnResult;
        },
      } as Partial<FusionDelegateDeps>,
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "t", title: "T", instructions: "models and tests", files: ["models.py", "test_models.py"] }] },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(d.briefs).toHaveLength(2);
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    expect(row.status).toBe("ok");
    expect(row.notes?.join(" ")).not.toContain("unchanged by this task");
    rmSync(dir, { recursive: true, force: true });
  });

  it("says the review is done when the judge is green and the verify passed, and only then (k3d)", async () => {
    const run = async (green: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "judge-rev-"));
      const d = deps(
        dir,
        async () => ({ content: JSON.stringify({ items: [{ id: "a2", pass: green, why: "score" }] }) }),
        {
          resolveRunMode: () => mode({ autoVerify: { maxRounds: 0 } }),
          dispatchVerify: async () =>
            compressToolResult({
              tool: "verify.run",
              status: "ok",
              output: "verify.run command: ok",
              details: { ok: true, kind: "command", exitCode: 0, stdoutTail: "1 passed", stderrTail: "", description: "python -m pytest -q", checks: [], isolated: true, durationMs: 5 },
            }),
        },
      );
      const result = await buildFusionDelegateTool(d).run(
        { tasks: TASK, verify: { kind: "command", cmd: "python", args: ["-m", "pytest", "-q"], checks: ["exit 0"] } },
        { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
      );
      rmSync(dir, { recursive: true, force: true });
      return result;
    };
    const green = await run(true);
    // Right under the verify's verdict and diffstat, above the rows.
    const lines = green.summary.split("\n");
    expect(lines[0]).toMatch(/^autoverify: PASS/);
    expect(lines[1]).toMatch(/^diffstat: /);
    expect(lines[2]).toBe(REVIEWED_NOTE);
    expect(green.details.reviewed).toBe(true);
    const red = await run(false);
    expect(red.summary).not.toContain("reviewed:");
    expect(red.details).not.toHaveProperty("reviewed");
  });

  // k8b (16-11-2026): a tests task was red for "tests not run" and the
  // core task's NameError reached no retry; the verify ran only after
  // both rounds.
  const PYTEST = { kind: "command", cmd: "python", args: ["-m", "pytest", "-q"], checks: ["exit 0"] };
  const verifyRun = (ok: boolean) =>
    compressToolResult({
      tool: "verify.run",
      status: ok ? "ok" : "error",
      output: ok ? "verify.run command: ok" : "verify.run command: failed",
      details: {
        ok,
        kind: "command",
        exitCode: ok ? 0 : 1,
        stdoutTail: ok
          ? "1 passed"
          : "E   NameError: name 'cellers' is not defined\n=========================== short test summary info ============================\nFAILED test_ark.py::test_sum - NameError: name 'cellers' is not defined\n========================= 1 failed in 0.05s =========================",
        stderrTail: "",
        description: "python -m pytest -q",
        checks: [],
        isolated: true,
        durationMs: 5,
      },
    });

  it("runs the verify before each round: the judge reads it, the retry gets its failure, autoverify reuses the last (k8b)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-pre-"));
    const prompts: string[] = [];
    let verifies = 0;
    const d = deps(
      dir,
      async (call) => {
        prompts.push(call.prompt);
        const green = prompts.length > 1;
        return { content: JSON.stringify({ items: [{ id: "a2", pass: green, why: green ? "ok" : "tests fail" }] }) };
      },
      {
        resolveRunMode: () => mode({ autoVerify: { maxRounds: 0 } }),
        dispatchVerify: async () => verifyRun(++verifies > 1),
      },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK, verify: PYTEST },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    // One run before each round; autoverify takes the second, as nothing wrote after it.
    expect(verifies).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(
      "## Run by the runtime after every task finished (a fact, not the workers' words)\n- `python -m pytest -q`: FAILED (exit 1); its output:\n```\nE   NameError: name 'cellers' is not defined",
    );
    // After the records, before the call to answer; never in the cached rules.
    expect(prompts[0]!.indexOf("## Run by the runtime")).toBeGreaterThan(prompts[0]!.indexOf("## Evidence"));
    expect(prompts[0]!.indexOf("## Run by the runtime")).toBeLessThan(prompts[0]!.indexOf("Answer now"));
    expect(JUDGE_RULES).not.toContain("Run by the runtime");
    expect(d.briefs[1]).toContain(
      "The runtime ran `python -m pytest -q` after every task finished; it failed (exit 1). Part of it may come from another task's files — fix what is in yours:",
    );
    expect(d.briefs[1]).toContain("FAILED test_ark.py::test_sum - NameError: name 'cellers' is not defined");
    const followUp = prompts[1]!.slice(prompts[0]!.length);
    expect(followUp).toContain(
      "### Run by the runtime after the retry finished (a fact, not the workers' words)\n- `python -m pytest -q`: passed (exit 0)",
    );
    expect(result.summary.split("\n")[0]).toBe("autoverify: PASS after 1 round (exit 0) — `python -m pytest -q`");
    const row = (result.details.tasks as Array<{ status: string }>)[0]!;
    expect(row.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the verify once for a green first round, and not at all without a verify (k8b)", async () => {
    const run = async (withVerify: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "judge-pre1-"));
      const prompts: string[] = [];
      let verifies = 0;
      const d = deps(
        dir,
        async (call) => {
          prompts.push(call.prompt);
          return { content: JSON.stringify({ items: [{ id: "a2", pass: true, why: "ok" }] }) };
        },
        {
          resolveRunMode: () => mode({ autoVerify: { maxRounds: 0 } }),
          dispatchVerify: async () => verifyRun(++verifies > 0),
        },
      );
      const result = await buildFusionDelegateTool(d).run(
        { tasks: TASK, ...(withVerify ? { verify: PYTEST } : {}) },
        { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
      );
      rmSync(dir, { recursive: true, force: true });
      return { prompts, verifies, result };
    };
    const verified = await run(true);
    expect(verified.verifies).toBe(1);
    expect(verified.prompts).toHaveLength(1);
    expect(verified.prompts[0]).toContain("- `python -m pytest -q`: passed (exit 0)");
    expect(verified.result.summary.split("\n")[0]).toMatch(/^autoverify: PASS after 1 round/);
    const plain = await run(false);
    expect(plain.verifies).toBe(0);
    expect(plain.prompts[0]).not.toContain("## Run by the runtime after every task finished");
  });

  // Fable 3 (k8e, 16-11-2026): the core task was red for a test file it
  // wrote to drive its own code; the verify was green and the retry ran
  // out the clock.
  it("reports a red for strays alone with the verify passing, and still retries a defect (Fable 3)", async () => {
    const run = async (o: { stray: boolean; verifyOk: boolean }) => {
      const dir = mkdtempSync(join(tmpdir(), "judge-scope-"));
      const prompts: string[] = [];
      const d = deps(
        dir,
        async (call) => {
          prompts.push(call.prompt);
          const green = prompts.length > 1;
          return {
            content: JSON.stringify({
              items: [{ id: "a2", pass: green, why: green ? "ok" : "wrote probe.py outside its files" }],
            }),
          };
        },
        {
          resolveRunMode: () => mode({ autoVerify: { maxRounds: 0 } }),
          dispatchVerify: async () => verifyRun(o.verifyOk),
        },
      );
      d.runTurn = async (_session, message, options) => {
        d.briefs.push(message);
        const files = ["a.txt", ...(o.stray && d.briefs.length === 1 ? ["probe.py"] : [])];
        for (const file of files) {
          writeFileSync(join(dir, file), "x");
          options.eventHook?.({
            type: "llm_event",
            event: {
              type: "tool_call_executed",
              result: { tool: "os.fs.write", status: "ok", summary: `wrote ${file}`, details: { path: join(dir, file) }, truncated: false },
              batchIndex: 0,
              batchSize: 1,
            } as never,
          });
        }
        return {
          session: createEmptySessionState({ id: "s-w", workingDir: dir }),
          reason: "reply",
          stepCount: 1,
        } as RunTurnResult;
      };
      const result = await buildFusionDelegateTool(d).run(
        { tasks: TASK, verify: PYTEST },
        { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
      );
      rmSync(dir, { recursive: true, force: true });
      const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
      return { briefs: d.briefs.length, prompts, row };
    };
    const scope = await run({ stray: true, verifyOk: true });
    expect(scope.briefs).toBe(1);
    expect(scope.prompts).toHaveLength(1);
    expect(scope.prompts[0]).toContain("- written outside its declared files, owned by no task: probe.py");
    expect(scope.row.status).toBe("needs_orchestrator");
    expect(scope.row.notes?.join(" ")).toContain(
      "judge: red for scope only, not retried — a2 wrote probe.py outside its files; the fan-out's verify passed and the task wrote probe.py outside its declared files (no task owns them)",
    );
    // A failing verify, or a red with nothing stray, is a defect to repair.
    const failing = await run({ stray: true, verifyOk: false });
    expect(failing.briefs).toBe(2);
    const clean = await run({ stray: false, verifyOk: true });
    expect(clean.briefs).toBe(2);
    expect(clean.prompts[0]).not.toContain("written outside its declared files");
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
    expect(prompts[0]).toContain("commands run: none that reached its exit");
    expect(prompts[1]).toContain("files written by the file tools: a.txt, b.txt");
    expect(prompts[1]).toContain("1. `python -m pytest -q` — exit 0");
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

  it("judges a fan-out's round in one call, not one per task (k3a, 15-11-2026)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-fan-"));
    const prompts: string[] = [];
    const d = deps(dir, async (call) => {
      prompts.push(call.prompt);
      return { content: JSON.stringify({ red: [], pass: ["t:a2", "u:a1"] }) };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [...TASK, { id: "u", title: "U", instructions: "say the score" }] },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Task t");
    expect(prompts[0]).toContain("## Task u");
    expect(prompts[0]).toMatch(/- u:a1: the task is done as instructed/);
    const rows = result.details.tasks as Array<{ id: string; status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("one judge call for several tasks", () => {
  const facts = { checkOutcomes: [], findings: [] };
  const base = (dir: string, complete: EscalationComplete) => ({
    facts,
    contract: undefined,
    workingDir: dir,
    target: TARGET,
    pricing: undefined,
    complete,
    signal: new AbortController().signal,
  });

  it("asks once, names items <task>:<item>, shows a shared file once and keeps the entries' order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-batch-"));
    writeFileSync(join(dir, "models.py"), "class Todo: pass\n");
    writeFileSync(join(dir, "cli.py"), "print('Tilfoejet')\n");
    const a: DelegateTask = { id: "pkg", title: "P", instructions: "write the model", files: ["models.py"] };
    const b: DelegateTask = { id: "cli", title: "C", instructions: "write the CLI", files: ["cli.py", "./models.py"] };
    const prompts: string[] = [];
    const tokens: number[] = [];
    const verdicts = await judgeTasks({
      ...base(dir, async (call) => {
        prompts.push(call.prompt);
        tokens.push(call.maxOutputTokens ?? 0);
        return { content: '{"red":[{"id":"cli:a3","why":"prints Tilføjet"}],"pass":["pkg:a2","cli:a3"]}' };
      }),
      entries: [
        { task: b, items: buildAcceptanceChecklist(b, undefined), reply: "" },
        { task: a, items: buildAcceptanceChecklist(a, undefined), reply: "" },
      ],
    });
    expect(prompts).toHaveLength(1);
    expect(tokens[0]).toBe(2 * JUDGE_MAX_OUTPUT_TOKENS);
    expect(prompts[0]!.split("class Todo").length - 1).toBe(1);
    expect(prompts[0]).toContain("Workers say they finished the 2 tasks below");
    expect(prompts[0]).toContain("- cli:a3: the task is done as instructed (its instructions are above)");
    expect(prompts[0]).toContain("- pkg:a1: met — 17 bytes");
    expect([...verdicts.keys()]).toEqual(["cli", "pkg"]);
    // Named both red and passed: red wins.
    expect(verdicts.get("cli")).toMatchObject({ green: false });
    expect(verdicts.get("cli")!.items.find((i) => i.id === "a3")).toMatchObject({
      pass: false,
      why: "prints Tilføjet",
      by: "judge",
    });
    expect(verdicts.get("pkg")).toMatchObject({ green: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not ask for a task whose fact is red, and asks the rest with plain ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-batch-red-"));
    writeFileSync(join(dir, "a.txt"), "score 3");
    const ok: DelegateTask = { id: "ok", title: "O", instructions: "write a.txt", files: ["a.txt"] };
    const gone: DelegateTask = { id: "gone", title: "G", instructions: "write b.txt", files: ["b.txt"] };
    const prompts: string[] = [];
    const verdicts = await judgeTasks({
      ...base(dir, async (call) => {
        prompts.push(call.prompt);
        return { content: '{"red":[],"pass":["a2"]}' };
      }),
      entries: [
        { task: gone, items: buildAcceptanceChecklist(gone, undefined), reply: "" },
        { task: ok, items: buildAcceptanceChecklist(ok, undefined), reply: "" },
      ],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("write b.txt");
    expect(prompts[0]).toContain("- a2: the task is done as instructed");
    expect(verdicts.get("ok")).toMatchObject({ green: true });
    expect(verdicts.get("gone")!.items.map((i) => i.by)).toEqual(["fact", "skipped"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("splits the call's cost over the tasks it asked, and leaves them all unverified when it fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-batch-cost-"));
    writeFileSync(join(dir, "a.txt"), "x");
    writeFileSync(join(dir, "b.txt"), "y");
    const t1: DelegateTask = { id: "t1", title: "1", instructions: "write a.txt", files: ["a.txt"] };
    const t2: DelegateTask = { id: "t2", title: "2", instructions: "write b.txt", files: ["b.txt"] };
    const entries = [
      { task: t1, items: buildAcceptanceChecklist(t1, undefined), reply: "" },
      { task: t2, items: buildAcceptanceChecklist(t2, undefined), reply: "" },
    ];
    const pricing = { input: 1_000_000, output: 0 };
    const priced = await judgeTasks({
      ...base(dir, async () => ({
        content: '{"red":[],"pass":["t1:a2"]}',
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      })),
      pricing,
      entries,
    });
    expect(priced.get("t1")).toMatchObject({ green: true });
    // Left out of both lists: red, never green.
    expect(priced.get("t2")!.items.find((i) => i.id === "a2")).toMatchObject({
      pass: false,
      why: "the judge gave no verdict",
    });
    const costs = [...priced.values()].map((v) => v.costUsd);
    expect(costs[0]).toBeGreaterThan(0);
    expect(costs[0]).toBe(costs[1]);
    const failed = await judgeTasks({
      ...base(dir, async () => {
        throw new Error("cli exited 1");
      }),
      entries,
    });
    expect([...failed.values()].map((v) => v.unverified)).toEqual([
      "the judge could not run: cli exited 1",
      "the judge could not run: cli exited 1",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the compact answer and the older one; neither list nor items is unreadable", () => {
    expect(parseJudgeAnswer('{"red":[{"id":"a1","why":"wrong"}],"pass":["a2",{"id":"a3"}]}')).toEqual(
      new Map([
        ["a2", { pass: true, why: "met" }],
        ["a3", { pass: true, why: "met" }],
        ["a1", { pass: false, why: "wrong" }],
      ]),
    );
    expect(parseJudgeAnswer('{"red":["a1"]}')!.get("a1")).toEqual({ pass: false, why: "no reason given" });
    expect(parseJudgeAnswer('{"items":[{"id":"a1","pass":true,"why":"ok"}]}')!.get("a1")!.pass).toBe(true);
    expect(parseJudgeAnswer('{"verdict":"green"}')).toBeNull();
    expect(parseJudgeAnswer("null")).toBeNull();
  });
});

describe("scopeOnlyRed (Fable 3)", () => {
  const items: AcceptanceItem[] = [
    { id: "a1", kind: "file", text: "a.txt exists and is not empty", path: "a.txt", judged: false },
    { id: "a2", kind: "instructions", text: "the task is done as instructed: x", judged: true },
  ];
  const verdict = (red: string[]): JudgeVerdict => ({
    green: red.length === 0,
    items: items.map((i) => ({ id: i.id, pass: !red.includes(i.id), why: "w", by: "judge" as const })),
    costUsd: null,
  });
  const passed = { ok: true, exitCode: 0, excerpt: [] };
  const strays = ["/w/probe.py"];

  it("holds only for a red on the instructions alone, with strays and a passing verify", () => {
    expect(scopeOnlyRed(items, verdict(["a2"]), strays, passed)).toBe(true);
    expect(scopeOnlyRed(items, verdict(["a1", "a2"]), strays, passed)).toBe(false);
    expect(scopeOnlyRed(items, verdict(["a2"]), [], passed)).toBe(false);
    expect(scopeOnlyRed(items, verdict(["a2"]), strays, { ...passed, ok: false, exitCode: 1 })).toBe(false);
    expect(scopeOnlyRed(items, verdict(["a2"]), strays, undefined)).toBe(false);
    expect(scopeOnlyRed(items, verdict([]), strays, passed)).toBe(false);
    expect(scopeOnlyRed(items, { ...verdict(["a2"]), unverified: "timed out" }, strays, passed)).toBe(false);
  });

  it("shows the strays to the judge on a line of their own, and no line when there are none", () => {
    const w = join(tmpdir(), "w");
    const record = { runs: [], written: [join(w, "a.txt"), join(w, "probe.py")] };
    expect(renderRuntimeRecord({ ...record, strays: [join(w, "probe.py")] }, w)).toContain(
      "- files written by the file tools: a.txt, probe.py\n- written outside its declared files, owned by no task: probe.py\n- commands run: none",
    );
    expect(renderRuntimeRecord({ ...record, strays: [] }, w)).not.toContain("written outside");
    expect(renderRuntimeRecord(record, w)).not.toContain("written outside");
  });
});
