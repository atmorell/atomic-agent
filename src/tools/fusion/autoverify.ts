/**
 * Autoverify (lever F1, `llm.runMode.fusion.autoVerify`): `fusion.delegate`
 * runs the orchestrator's `verify` spec after the workers, hands a
 * failure back to a local repair worker and verifies again, up to
 * `autoVerifyRounds` repairs. The orchestrator gets one compact block —
 * pass/fail, rounds, exit code, a bounded failure excerpt and a diff
 * stat — instead of spending its own calls on `verify.run`.
 *
 * Every verify goes through the injected `dispatch`, which is the
 * dispatch path a model-emitted `verify.run` takes (shell guard,
 * approval or fan-out scope, read scope, hooks, cancellation). A verify
 * that did not run — denied, blocked, refused, malformed — stops the
 * loop: nothing is repaired and nothing is verified again.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";

import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { CancelledError } from "../../llm/index.js";
import type { ToolContext } from "../tool-registry.js";
import { evaluateChecks } from "../verify/verify-checks.js";
import { parseVerifyRunArgs } from "../verify/verify-run-args.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  commandLineOf,
  type WorkerCommandRun,
  type WorkerTaskResult,
} from "./worker-result.js";

/** At most this many lines of failure output reach the orchestrator. */
export const AUTOVERIFY_EXCERPT_LINES = 30;
const EXCERPT_LINE_CHARS = 200;
/** Lines of the first assertion block (`E   …`) kept ahead of the summary. */
const ASSERTION_LINES = 10;
const DIFFSTAT_FILES_SHOWN = 12;
const SNAPSHOT_MAX_FILES = 64;
const SNAPSHOT_MAX_BYTES = 1_000_000;
/** Hard cap on the rendered block. */
export const AUTOVERIFY_BLOCK_CHARS = 4000;
/**
 * Steps one repair worker gets, unless the configured worker budget is
 * smaller. A repair is a narrow fix with the failure and the work's
 * changes in its brief; with the full worker budget (60 steps, 45 min)
 * two rounds kept the orchestrator waiting over half an hour on a
 * failure it could have read in one call.
 */
export const AUTOVERIFY_REPAIR_MAX_STEPS = 12;
/** At most this many changed lines go into a repair brief. */
export const AUTOVERIFY_CHANGE_LINES = 40;

export type AutoVerifyDispatch = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<CompressedToolResult>;

export interface AutoVerifyDiffRow {
  path: string;
  added: number;
  removed: number;
}

export interface AutoVerifyRepairRow {
  id: string;
  status: WorkerTaskResult["status"];
  stepCount: number;
  error?: string;
}

export interface AutoVerifyReport {
  /** `not_run`: the verify never ran (denied, blocked, refused, cancelled, stopped). */
  status: "pass" | "fail" | "not_run";
  /** Verify runs made (the first plus one per repair). */
  rounds: number;
  /** The last run's exit code; `null` when none ran or it had none. */
  exitCode: number | null;
  /** What was run, in verify.run's own one-line description. */
  command?: string;
  /** Bounded failure output of the last failing run. */
  excerpt: string[];
  diffstat: AutoVerifyDiffRow[];
  repairs: AutoVerifyRepairRow[];
  /** Why the loop stopped short of a pass, when it did. */
  reason?: string;
  /** The pass is the worker's own run of the command, not a new one (`reusableWorkerRun`). */
  reused?: boolean;
}

/**
 * The call's `verify` argument: absent (`args` undefined), a spec
 * object, or a refusal when it is there but not an object. The spec
 * itself is verify.run's to parse, on its own dispatch.
 */
export function readAutoVerifyArgs(
  raw: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const value = raw.verify;
  if (value === undefined || value === null) return { ok: true, args: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "fusion.delegate: `verify` must be a verify.run args object" };
  }
  return { ok: true, args: value as Record<string, unknown> };
}

export type VerifyVerdict =
  | { ran: true; ok: boolean; exitCode: number | null; command?: string; excerpt: string[] }
  | { ran: false; reason: string };

function head(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * What one dispatched verify said. `details.kind` is set only by a run
 * that started; a run that could not happen (`details.error` beside it:
 * no browser, a bad `cwd`, a spawn failure) is not something a repair
 * of the code can fix, so it stops the loop too.
 */
export function classifyVerifyResult(result: CompressedToolResult): VerifyVerdict {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const summary = typeof result.summary === "string" ? result.summary : "";
  if (typeof details.kind !== "string") {
    const why =
      typeof details.errorName === "string"
        ? `${details.errorName}: ${head(summary, 200)}`
        : typeof details.guardRule === "string"
          ? `blocked by shell guard rule ${details.guardRule}`
          : head(summary || String(details.error ?? "refused"), 200);
    return { ran: false, reason: why };
  }
  const command = typeof details.description === "string" ? details.description : undefined;
  if (typeof details.error === "string") {
    return { ran: false, reason: `the verify could not run: ${head(details.error, 200)}` };
  }
  const exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
  const ok = result.status === "ok";
  return {
    ran: true,
    ok,
    exitCode,
    ...(command === undefined ? {} : { command }),
    excerpt: ok
      ? []
      : failureExcerpt(
          typeof details.stdoutTail === "string" ? details.stdoutTail : "",
          typeof details.stderrTail === "string" ? details.stderrTail : "",
          summary,
        ),
  };
}

/**
 * The most telling lines of a failing run, at most 30: pytest's first
 * assertion block (`>` line plus its `E` lines), then its short test
 * summary through the closing line. Anything else: the last lines of
 * the output tails, then of the summary.
 */
export function failureExcerpt(stdout: string, stderr: string, summary = ""): string[] {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trimEnd());
  const out: string[] = [];
  const firstE = lines.findIndex((l) => /^E\s/.test(l));
  if (firstE >= 0) {
    const start = firstE > 0 && /^>\s/.test(lines[firstE - 1]!) ? firstE - 1 : firstE;
    let end = firstE;
    while (end < lines.length && /^E\s/.test(lines[end]!) && end - firstE < ASSERTION_LINES) end++;
    out.push(...lines.slice(start, end));
  }
  const summaryAt = lines.findIndex((l) => /^=+ short test summary info =+$/.test(l.trim()));
  if (summaryAt >= 0) {
    let end = summaryAt + 1;
    while (end < lines.length && !/^=+ .+ =+$/.test(lines[end]!.trim())) end++;
    out.push(...lines.slice(summaryAt, Math.min(end + 1, lines.length)));
  }
  let picked = out.filter((l) => l.trim() !== "");
  if (picked.length === 0) {
    const tail = lines.filter((l) => l.trim() !== "");
    picked =
      tail.length > 0
        ? tail.slice(-AUTOVERIFY_EXCERPT_LINES)
        : summary.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-AUTOVERIFY_EXCERPT_LINES);
  }
  return picked
    .slice(0, AUTOVERIFY_EXCERPT_LINES)
    .map((l) => (l.length > EXCERPT_LINE_CHARS ? `${l.slice(0, EXCERPT_LINE_CHARS)}…` : l));
}

export type FileSnapshot = Map<string, string | null>;

/** The declared files' text before and after, for the diff stat. Never throws. */
export async function snapshotFiles(
  workingDir: string,
  paths: readonly string[],
): Promise<FileSnapshot> {
  const snap: FileSnapshot = new Map();
  const unique = [...new Set(paths)].slice(0, SNAPSHOT_MAX_FILES);
  for (const path of unique) {
    const abs = resolvePath(workingDir, path);
    const key = relative(workingDir, abs).split("\\").join("/");
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > SNAPSHOT_MAX_BYTES) continue;
      snap.set(key, await readFile(abs, "utf8"));
    } catch {
      snap.set(key, null);
    }
  }
  return snap;
}

function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Lines added and removed per file, counted as a multiset difference
 * (order-blind, so a moved line is not counted) — deterministic and
 * cheap, close to `git diff --numstat` for ordinary edits.
 */
export function diffStat(before: FileSnapshot, after: FileSnapshot): AutoVerifyDiffRow[] {
  const rows: AutoVerifyDiffRow[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = splitLines(before.get(path) ?? null);
    const b = splitLines(after.get(path) ?? null);
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) counts.set(line, left - 1);
      else added++;
    }
    let removed = 0;
    for (const left of counts.values()) removed += left;
    if (added + removed > 0) rows.push({ path, added, removed });
  }
  return rows;
}

/**
 * The lines the work added, as `path:line + text` in the new file's
 * numbering, with a count of removed lines per file — the same
 * multiset difference as `diffStat`, capped at `max` lines.
 */
export function changedLines(
  before: FileSnapshot,
  after: FileSnapshot,
  max = AUTOVERIFY_CHANGE_LINES,
): string[] {
  const out: string[] = [];
  let hidden = 0;
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = splitLines(before.get(path) ?? null);
    const b = splitLines(after.get(path) ?? null);
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    b.forEach((line, i) => {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        return;
      }
      const text = line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS)}…` : line;
      if (out.length < max) out.push(`${path}:${i + 1} + ${text}`);
      else hidden++;
    });
    let removed = 0;
    for (const left of counts.values()) removed += left;
    if (removed > 0) {
      if (out.length < max) out.push(`${path}: ${removed} line${removed === 1 ? "" : "s"} removed`);
      else hidden++;
    }
  }
  if (hidden > 0) out.push(`… ${hidden} more`);
  return out;
}

/** The repair brief: the failing check, its excerpt, the work it judged. */
export function repairInstructions(
  verdict: { exitCode: number | null; command?: string; excerpt: readonly string[] },
  tasks: readonly Pick<DelegateTask, "id" | "title">[],
  changes: readonly string[] = [],
): string {
  return [
    "The work below was done, but its check fails. Fix the code so the check passes. Change only what the failure points at; do not weaken, skip or delete tests.",
    `Check: \`${verdict.command ?? "verify"}\` (exit ${verdict.exitCode ?? "none"})`,
    "Failure:",
    ...verdict.excerpt.map((l) => `  ${l}`),
    `Work done: ${tasks.map((t) => `${t.id} (${t.title})`).join("; ")}`,
    ...(changes.length === 0
      ? []
      : [
          // A repair worker once spent 30 minutes on two old tests that
          // failed only because the new test block stopped the instance
          // they share; the cause was in the lines it had just added.
          "The work changed these lines. A failing check the work did not touch was most likely broken by them (shared state, a stopped or restarted instance, a changed order) — read them before anything else:",
          ...changes.map((l) => `  ${l}`),
        ]),
    "Reply with what you changed and why.",
  ].join("\n");
}

/** The verify keys a reuse understands; any other (`env`, a service or page field) runs the verify. */
const REUSABLE_VERIFY_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "cmd",
  "args",
  "cwd",
  "timeoutMs",
  "network",
  "checks",
]);
/** A pipe, redirect, chain, expansion, glob or quote makes the line ambiguous. */
const SHELL_SYNTAX = /[|&;<>`$"'*?(){}[\]~^%!]/;

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const abs = resolvePath(p);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  return norm(a) === norm(b);
}

/**
 * True when the worker's own last run already answers the verify, so
 * autoverify need not run it again. Every condition must hold, and a
 * doubt runs the verify: a `command` spec with no `env`; the same
 * command line, free of shell syntax, and no argument with a space in
 * it; the same directory, inside the working directory; exit 0 within
 * the verify's timeout, not timed out, not a background job; no call
 * after it that can change a file; and checks limited to `exit 0` and
 * `stdout contains "x"`, met by the run's stdout tail (a needle found
 * in the tail is in the whole output too).
 *
 * The run happened in the working directory itself, not in a throwaway
 * copy, and without verify's network block.
 */
export function reusableWorkerRun(
  verifyArgs: Record<string, unknown>,
  run: WorkerCommandRun | undefined,
  workingDir: string,
): boolean {
  if (run === undefined) return false;
  if (Object.keys(verifyArgs).some((k) => !REUSABLE_VERIFY_KEYS.has(k))) return false;
  let parsed: ReturnType<typeof parseVerifyRunArgs>;
  try {
    parsed = parseVerifyRunArgs(verifyArgs);
  } catch {
    return false;
  }
  if (parsed.kind !== "command" || parsed.cmd === undefined || parsed.env !== undefined) return false;
  const args = parsed.args ?? [];
  const line = commandLineOf(parsed.cmd, args);
  if (line === "" || SHELL_SYNTAX.test(line) || args.some((a) => /\s/.test(a))) return false;
  if (!run.lines.includes(line)) return false;
  const cwd =
    parsed.cwd === undefined
      ? workingDir
      : isAbsolute(parsed.cwd)
        ? resolvePath(parsed.cwd)
        : resolvePath(workingDir, parsed.cwd);
  const inside = relative(resolvePath(workingDir), cwd);
  if (inside.startsWith("..") || isAbsolute(inside)) return false;
  if (!sameDir(cwd, run.cwd)) return false;
  if (run.exitCode !== 0 || run.timedOut || run.changedAfter) return false;
  if (run.durationMs === undefined || run.durationMs > parsed.timeoutMs) return false;
  const checks = parsed.checks ?? [];
  for (const check of checks) {
    const tokens = check.trim().split(/\s+/);
    const exitZero =
      tokens[0] === "exit" &&
      ((tokens.length === 2 && tokens[1] === "0") ||
        (tokens.length === 3 && tokens[1] === "==" && tokens[2] === "0"));
    const stdoutHas = tokens[0] === "stdout" && tokens[1] === "contains";
    if (!exitZero && !stdoutHas) return false;
    if (stdoutHas && run.stdoutTail === undefined) return false;
  }
  return evaluateChecks(checks, {
    kind: "command",
    exitCode: 0,
    timedOut: false,
    stdout: run.stdoutTail ?? "",
  }).every((c) => c.ok);
}

export interface RunAutoVerifyInput {
  verifyArgs: Record<string, unknown>;
  /**
   * The worker's last command run, for a call of one task that ended
   * ok. A run `reusableWorkerRun` accepts is the pass; nothing is run.
   */
  reuse?: WorkerCommandRun | undefined;
  /** Repairs allowed after the first verify (0..5). */
  maxRepairs: number;
  /** Step budget of each repair task (`AUTOVERIFY_REPAIR_MAX_STEPS` or less). */
  repairMaxSteps: number;
  dispatch: AutoVerifyDispatch;
  ctx: ToolContext;
  tasks: readonly DelegateTask[];
  /** Runs one repair task; never throws (`runWorkerTasks`). */
  repair: (task: DelegateTask) => Promise<WorkerTaskResult[]>;
  /** A reason to start no further repair (a turn cap), or undefined. */
  stopReason: () => string | undefined;
  before: FileSnapshot;
  snapshot: () => Promise<FileSnapshot>;
}

/** Verify, repair on a failure, verify again — bounded. Never throws. */
export async function runAutoVerify(input: RunAutoVerifyInput): Promise<AutoVerifyReport> {
  const repairs: AutoVerifyRepairRow[] = [];
  const files = [...new Set(input.tasks.flatMap((t) => t.files ?? []))];
  let rounds = 0;
  let last: VerifyVerdict | undefined;
  const done = async (
    status: AutoVerifyReport["status"],
    reason?: string,
  ): Promise<AutoVerifyReport> => {
    const ran = last?.ran === true ? last : undefined;
    return {
      status,
      rounds,
      exitCode: ran?.exitCode ?? null,
      ...(ran?.command === undefined ? {} : { command: ran.command }),
      excerpt: status === "fail" && ran !== undefined ? ran.excerpt : [],
      diffstat: diffStat(input.before, await input.snapshot()),
      repairs,
      ...(reason === undefined ? {} : { reason }),
    };
  };
  if (
    !input.ctx.signal.aborted &&
    reusableWorkerRun(input.verifyArgs, input.reuse, input.ctx.workingDir)
  ) {
    const parsed = parseVerifyRunArgs(input.verifyArgs);
    return {
      status: "pass",
      rounds: 1,
      exitCode: 0,
      command: commandLineOf(parsed.cmd ?? "", parsed.args ?? []),
      excerpt: [],
      diffstat: diffStat(input.before, await input.snapshot()),
      repairs,
      reused: true,
    };
  }
  for (;;) {
    if (input.ctx.signal.aborted) return done(rounds === 0 ? "not_run" : "fail", "cancelled");
    let result: CompressedToolResult;
    try {
      result = await input.dispatch(input.verifyArgs, input.ctx);
    } catch (err) {
      const reason =
        err instanceof CancelledError || input.ctx.signal.aborted
          ? "cancelled"
          : `the verify failed to dispatch: ${err instanceof Error ? err.message : String(err)}`;
      return done(rounds === 0 ? "not_run" : "fail", reason);
    }
    const verdict = classifyVerifyResult(result);
    if (!verdict.ran) {
      // Nothing ran: a later round's denial still leaves the last real
      // run's failure standing.
      return done(rounds === 0 ? "not_run" : "fail", verdict.reason);
    }
    rounds++;
    last = verdict;
    if (verdict.ok) return done("pass");
    if (repairs.length >= input.maxRepairs) {
      return done("fail", input.maxRepairs === 0 ? undefined : `still failing after ${repairs.length} repair${repairs.length === 1 ? "" : "s"}`);
    }
    const stop = input.stopReason();
    if (stop !== undefined) return done("fail", `no repair: ${stop}`);
    const round = repairs.length + 1;
    const task: DelegateTask = {
      id: `autoverify-repair-${round}`,
      title: `Repair until the check passes (round ${round})`,
      instructions: repairInstructions(
        verdict,
        input.tasks,
        changedLines(input.before, await input.snapshot()),
      ),
      maxSteps: input.repairMaxSteps,
      ...(files.length === 0 ? {} : { files }),
    };
    const rows = await input.repair(task);
    for (const row of rows) {
      repairs.push({
        id: row.id,
        status: row.status,
        stepCount: row.stepCount,
        ...(row.error === undefined ? {} : { error: head(row.error, 200) }),
      });
    }
    if (rows.length === 0) repairs.push({ id: task.id, status: "cancelled", stepCount: 0, error: "not started" });
  }
}

/** The orchestrator's view of the report: a few lines, hard-capped. */
export function renderAutoVerifyBlock(report: AutoVerifyReport): string {
  const what = report.command === undefined ? "" : ` — \`${head(report.command, 160)}\``;
  const repaired =
    report.repairs.length === 0
      ? ""
      : `, ${report.repairs.length} repair${report.repairs.length === 1 ? "" : "s"}: ${report.repairs.map((r) => `${r.id} ${r.status}`).join(", ")}`;
  const headLine =
    report.status === "not_run"
      ? `autoverify: NOT RUN — ${report.reason ?? "no verify ran"}`
      : `autoverify: ${report.status === "pass" ? "PASS" : "FAIL"} after ${report.rounds} round${report.rounds === 1 ? "" : "s"} (exit ${report.exitCode ?? "none"}${repaired})${what}${report.status === "fail" && report.reason !== undefined ? ` — ${report.reason}` : ""}${report.reused === true ? " — reused the worker's own passing run (no file changed after it)" : ""}`;
  const lines = [headLine];
  if (report.excerpt.length > 0) {
    lines.push(`failure (${report.excerpt.length} line${report.excerpt.length === 1 ? "" : "s"}):`);
    lines.push(...report.excerpt.map((l) => `  ${l}`));
  }
  if (report.diffstat.length > 0) {
    const shown = report.diffstat.slice(0, DIFFSTAT_FILES_SHOWN);
    const added = report.diffstat.reduce((n, r) => n + r.added, 0);
    const removed = report.diffstat.reduce((n, r) => n + r.removed, 0);
    const more = report.diffstat.length - shown.length;
    lines.push(
      `diffstat: ${shown.map((r) => `${r.path} +${r.added} -${r.removed}`).join("; ")}${more > 0 ? `; … ${more} more` : ""} (${report.diffstat.length} file${report.diffstat.length === 1 ? "" : "s"}, +${added} -${removed})`,
    );
  } else if (report.status !== "not_run") {
    lines.push("diffstat: no change in the declared files");
  }
  const block = lines.join("\n");
  return block.length > AUTOVERIFY_BLOCK_CHARS ? `${block.slice(0, AUTOVERIFY_BLOCK_CHARS - 1)}…` : block;
}
