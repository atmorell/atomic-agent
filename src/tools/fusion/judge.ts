import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import type { DelegateTask } from "./delegate-args.js";
import { describeProvide, type DelegateContract } from "./contract.js";
import type {
  ContractCheckOutcome,
  ContractFinding,
} from "./contract-checks.js";
import type { EscalationComplete } from "./escalation.js";
import type {
  WorkerCommandRun,
  WorkerPricing,
  WorkerTaskResult,
} from "./worker-result.js";

/**
 * The trimmed judge (ATO-944): a node is closed by its acceptance list,
 * not by its worker saying "done".
 *
 * Every benchmark run so far reported "verified" over wrong scenes: the
 * contract's checks catch a crash, not wrong behaviour, and the worker's
 * own reply is the least reliable witness there is. So, with
 * `llm.runMode.fusion.judge: "on"`:
 *
 *  1. **Before the work** each task gets an acceptance checklist built
 *     from the contract — its `checks`, its `provides`, its declared
 *     files — plus its deliverable and instructions. The worker reads it
 *     in its brief and cannot change it.
 *  2. **After the work** the list is checked. Facts first: a check that
 *     failed or did not run, a provide that is missing, a declared file
 *     that is absent or empty are red, whatever any model says. Then a
 *     judge in a fresh context — no worker transcript, no worker claims
 *     about files — reads the files themselves and rules on the items no
 *     script can (the deliverable, a provide's shape, the instructions).
 *     Beside the files it reads the runtime's own record of the worker's
 *     calls: each command that reached an exit (line, exit code, end of
 *     stdout), oldest first, and the files its write tools named. Without
 *     it an instruction such as "run pytest and report the result" could
 *     never be shown met, and correct work was re-run (ap2c, 15-11-2026).
 *     It lists every run, not only the last: a worker that ran pytest
 *     (22 passed) and then counted lines was ruled "pytest did not run"
 *     when the record held only the count (ap3i, 15-11-2026).
 *     It also reads the user's original request, which the worker's
 *     brief already quotes, with one extra item: an exact name, message
 *     or format the request fixes is used verbatim. Without it the judge
 *     knew only the orchestrator's brief, which left out the exact
 *     output lines, and "Tilføjet" for the requested "Tilfoejet" passed
 *     (ap3b, 15-11-2026).
 *     It fails an item only for a defect in what the user gets, never for
 *     style the request does not ask for (`JUDGE_SEVERITY_RULE`, ap3h).
 *     The judge can only add red: it never turns a failed fact green.
 *     An item it gives no verdict for is red. An answer that cannot be
 *     read leaves the node unverified, never green.
 *  3. A red list re-runs the task once with the judge's findings; a list
 *     still red after that is reported as failed, item by item.
 */

export type AcceptanceItemKind =
  | "check"
  | "provide"
  | "file"
  | "deliverable"
  | "instructions"
  | "request";

export interface AcceptanceItem {
  id: string;
  kind: AcceptanceItemKind;
  text: string;
  /** `check`: index into `contract.checks`, i.e. into the check outcomes. */
  checkIndex?: number;
  /** `provide`: the provide's name, to find its presence finding. */
  provideName?: string;
  /** `provide` with a shape: the judge also rules on the meaning. */
  judged: boolean;
  /** `file`: the declared path. */
  path?: string;
}

const INSTRUCTIONS_ITEM_CHARS = 300;
/**
 * How much of all files the judge reads. The budget is shared out, not
 * capped per file: a fixed 6 000-char cap per file clipped a one-file
 * task's 12 000-char test file in half while 18 000 chars of budget sat
 * unused, and the judge sent correct tests back as "not shown" (ap3g,
 * 15-11-2026). See `shareEvidenceBudget`.
 */
export const JUDGE_EVIDENCE_CHARS = 24_000;
/**
 * What each further task in one judge call adds to the evidence budget
 * (`gatherBatchEvidence`), up to twice `JUDGE_EVIDENCE_CHARS`. Tasks of
 * one fan-out often share files, which are then shown once.
 */
export const JUDGE_EVIDENCE_EXTRA_CHARS = 12_000;
/** Room for the red items' one-line reasons; times the tasks asked, up to 3. */
export const JUDGE_MAX_OUTPUT_TOKENS = 1_200;
/** How much of the worker's last command's stdout the judge reads. */
export const JUDGE_RUN_CHARS = 1_500;
/** How much of each earlier command's stdout the judge reads. */
export const JUDGE_EARLIER_RUN_CHARS = 400;
/** How much of the user's original request the judge reads. */
export const JUDGE_REQUEST_CHARS = 4_000;
/**
 * What makes an item fail. In ap3h (15-11-2026) the judge sent a working
 * package back for "why" comments, the import form and test thoroughness
 * the user never asked for; the retry cost four minutes and a third
 * delegation, while the one real defect (`from_dict` for the request's
 * `fra_dict`) sat in another task. A defect fails; taste is noted and passes.
 */
export const JUDGE_SEVERITY_RULE =
  "Fail an item only for a defect that changes what the user gets: behaviour that is wrong or missing; a file, function or test that is missing or asserts the wrong thing; a name, message, output line or format that differs from the request; or a required run that failed or did not happen. " +
  "Do not fail an item for style the user's request does not ask for — comments, docstrings, import form, helper names, or a test that is correct but could be more thorough — even when the task's wording asks for it: pass the item.";

/**
 * What the runtime itself recorded of a task's workers — not their
 * words: the shell runs that reached their exit, oldest first (one per
 * command line, `WorkerRunCollector.commandRuns`), and the paths their
 * write, edit, patch and restore calls named.
 */
export interface JudgeRecord {
  runs: readonly WorkerCommandRun[];
  written: readonly string[];
}

export function renderRuntimeRecord(record: JudgeRecord, workingDir: string): string {
  const shown = (path: string): string => {
    const rel = relative(workingDir, path);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
      ? rel.replace(/\\/g, "/")
      : path;
  };
  const lines = [
    "## Recorded by the runtime (facts, not the worker's words)",
    record.written.length === 0
      ? "- files written by the file tools: none"
      : `- files written by the file tools: ${record.written.map(shown).join(", ")}`,
  ];
  if (record.runs.length === 0) {
    lines.push("- commands run: none that reached its exit");
    return lines.join("\n");
  }
  lines.push(
    "- commands run to their exit, oldest first (a command run again shows its last run only):",
  );
  record.runs.forEach((run, index) => {
    const flags = [
      `exit ${run.exitCode ?? "unknown"}`,
      ...(run.timedOut ? ["timed out"] : []),
      ...(run.changedAfter ? ["files may have changed after it"] : []),
    ];
    lines.push(`  ${index + 1}. \`${run.lines[0] ?? ""}\` — ${flags.join(", ")}`);
    const stdout = run.stdoutTail?.trimEnd();
    if (stdout === undefined || stdout.length === 0) return;
    const limit = index === record.runs.length - 1 ? JUDGE_RUN_CHARS : JUDGE_EARLIER_RUN_CHARS;
    const tail = stdout.length > limit ? `[…]${stdout.slice(-limit)}` : stdout;
    lines.push("     end of its stdout:", "```", tail, "```");
  });
  return lines.join("\n");
}

export function buildAcceptanceChecklist(
  task: DelegateTask,
  contract: DelegateContract | undefined,
  /** The user's original request; when there is one, its own item comes last. */
  originalRequest?: string,
): AcceptanceItem[] {
  const items: AcceptanceItem[] = [];
  const next = (): string => `a${items.length + 1}`;
  (contract?.checks ?? []).forEach((check, index) => {
    if (check.task !== task.id) return;
    const { task: _task, ...spec } = check;
    items.push({
      id: next(),
      kind: "check",
      text: `the check passes: ${JSON.stringify(spec).slice(0, 200)}`,
      checkIndex: index,
      judged: false,
    });
  });
  for (const provide of contract?.provides ?? []) {
    if (provide.task !== task.id) continue;
    items.push({
      id: next(),
      kind: "provide",
      text: `provides ${describeProvide(provide)}`,
      provideName: provide.name,
      judged: provide.shape !== undefined,
    });
  }
  for (const path of task.files ?? []) {
    items.push({
      id: next(),
      kind: "file",
      text: `${path} exists and is not empty`,
      path,
      judged: false,
    });
  }
  if (task.deliverable !== undefined && task.deliverable.trim().length > 0) {
    items.push({
      id: next(),
      kind: "deliverable",
      text: `the deliverable is met: ${task.deliverable.trim()}`,
      judged: true,
    });
  }
  const instructions = task.instructions.replace(/\s+/g, " ").trim();
  items.push({
    id: next(),
    kind: "instructions",
    text: `the task is done as instructed: ${instructions.length > INSTRUCTIONS_ITEM_CHARS ? `${instructions.slice(0, INSTRUCTIONS_ITEM_CHARS)}…` : instructions}`,
    judged: true,
  });
  if (originalRequest !== undefined && originalRequest.trim().length > 0) {
    items.push({
      id: next(),
      kind: "request",
      text: "every exact name, message, output line, format and value that the user's original request fixes for this task's part is used verbatim, character for character — the task's own wording does not override it",
      judged: true,
    });
  }
  return items;
}

/** What the worker reads in its brief: the list, read-only. */
export function renderAcceptanceBlock(items: readonly AcceptanceItem[]): string {
  return [
    "ACCEPTANCE CHECKLIST (read-only). After you finish, a separate judge with no access to this conversation checks every item against the files and check results — not against your reply. Your task does not close until every item is green:",
    ...items.map((item) => `- [${item.id}] ${item.text}`),
  ].join("\n");
}

export interface ItemVerdict {
  id: string;
  pass: boolean;
  why: string;
  /**
   * Who decided: a fact (check, presence, file), the judge, or nobody —
   * `skipped` when a fact was already red and the judge was not asked
   * (the list cannot be green either way; asking would only cost).
   */
  by: "fact" | "judge" | "skipped";
}

export interface JudgeVerdict {
  /** Every item green. */
  green: boolean;
  items: ItemVerdict[];
  /** Why no verdict could be reached, when none was; never green then. */
  unverified?: string;
  costUsd: number | null;
}

export interface JudgeFacts {
  /** Outcomes in `contract.checks` order (`runContractChecks`). */
  checkOutcomes: readonly (ContractCheckOutcome | undefined)[];
  findings: readonly ContractFinding[];
}

/** The facts' verdicts; `undefined` for an item only the judge can rule on. */
async function factVerdict(
  item: AcceptanceItem,
  facts: JudgeFacts,
  workingDir: string,
): Promise<ItemVerdict | undefined> {
  if (item.kind === "check") {
    const outcome = facts.checkOutcomes[item.checkIndex ?? -1];
    if (outcome === undefined) {
      return { id: item.id, pass: false, why: "the check did not run", by: "fact" };
    }
    return { id: item.id, pass: outcome.ok, why: outcome.detail, by: "fact" };
  }
  if (item.kind === "provide") {
    const finding = facts.findings.find((f) => f.name === item.provideName);
    if (finding !== undefined && !finding.present) {
      return {
        id: item.id,
        pass: false,
        why: finding.detail ?? `not found in ${finding.where.join(", ")}`,
        by: "fact",
      };
    }
    return item.judged
      ? undefined
      : {
          id: item.id,
          pass: finding !== undefined,
          why: finding === undefined ? "its presence could not be checked" : "present",
          by: "fact",
        };
  }
  if (item.kind === "file") {
    try {
      const info = await stat(absolute(item.path ?? "", workingDir));
      return info.isFile() && info.size > 0
        ? { id: item.id, pass: true, why: `${info.size} bytes`, by: "fact" }
        : { id: item.id, pass: false, why: "empty or not a file", by: "fact" };
    } catch {
      return { id: item.id, pass: false, why: "missing", by: "fact" };
    }
  }
  return undefined;
}

function absolute(path: string, workingDir: string): string {
  return isAbsolute(path) ? path : resolve(workingDir, path);
}

/** The paths a task declared: its files and where its provides live. */
function declaredPaths(task: DelegateTask, contract: DelegateContract | undefined): string[] {
  return [
    ...(task.files ?? []),
    ...(contract?.provides ?? [])
      .filter((p) => p.task === task.id && p.in !== undefined)
      .map((p) => p.in!),
  ].filter((p, i, all) => all.indexOf(p) === i);
}

/** The files the judge reads, clipped; the worker's reply only when there are none. */
export async function gatherEvidence(
  task: DelegateTask,
  contract: DelegateContract | undefined,
  reply: string,
  workingDir: string,
): Promise<string> {
  return gatherBatchEvidence([{ task, reply }], contract, workingDir);
}

/**
 * The evidence of one judge call over several tasks: every declared file
 * once, however many tasks name it (two tasks that both touch `models.py`
 * do not pay for it twice). A task that declared no files is judged on its
 * reply. All of it shares one budget, which grows by
 * `JUDGE_EVIDENCE_EXTRA_CHARS` for each task after the first, up to twice
 * the one-task budget.
 */
export async function gatherBatchEvidence(
  entries: ReadonlyArray<{ task: DelegateTask; reply: string }>,
  contract: DelegateContract | undefined,
  workingDir: string,
): Promise<string> {
  const single = entries.length === 1;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const path of entries.flatMap((e) => declaredPaths(e.task, contract))) {
    const key = absolute(path, workingDir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  const bodies = await Promise.all(
    paths.map(async (path) => {
      try {
        return await readFile(absolute(path, workingDir), "utf8");
      } catch {
        return undefined;
      }
    }),
  );
  const blocks: Array<{ head: string; body: string | undefined }> = [
    ...entries
      .filter((e) => declaredPaths(e.task, contract).length === 0)
      .map((e) => ({
        head: single
          ? "This task declared no files, so its reply is the deliverable. Judge what the reply contains, not what it says it did elsewhere.\n### reply"
          : `Task ${e.task.id} declared no files, so its reply is its deliverable. Judge what the reply contains, not what it says it did elsewhere.\n### reply of task ${e.task.id}`,
        body: e.reply,
      })),
    ...paths.map((path, i) => ({ head: `### ${path}`, body: bodies[i] })),
  ];
  const budget = Math.min(
    2 * JUDGE_EVIDENCE_CHARS,
    JUDGE_EVIDENCE_CHARS + JUDGE_EVIDENCE_EXTRA_CHARS * Math.max(0, entries.length - 1),
  );
  const caps = shareEvidenceBudget(
    blocks.map((b) => b.body?.length ?? 0),
    budget,
  );
  return blocks
    .map((block, i) => {
      if (block.body === undefined) return `${block.head}\n[missing]`;
      const cap = caps[i]!;
      const shown =
        block.body.length > cap
          ? `${block.body.slice(0, cap)}\n[… ${block.body.length - cap} more chars clipped]`
          : block.body;
      return `${block.head}\n${shown}`;
    })
    .join("\n\n");
}

/**
 * Each file's share of the evidence budget. Smallest first: a file that
 * fits in an even share of what is left is shown whole, and what it did
 * not use goes to the larger ones. Only files that together exceed the
 * budget are clipped, and those evenly.
 */
export function shareEvidenceBudget(
  lengths: readonly number[],
  budget: number,
): number[] {
  const caps = lengths.map(() => 0);
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  let left = budget;
  order.forEach((index, rank) => {
    const share = Math.floor(left / (order.length - rank));
    caps[index] = Math.min(lengths[index]!, share);
    left -= caps[index]!;
  });
  return caps;
}

/**
 * An item as the judge reads it. The instructions item does not repeat the
 * instructions the prompt already shows under the task, and the request
 * item leaves its "character for character" to the prompt's own rule:
 * the worker's brief keeps the full wording (`renderAcceptanceBlock`).
 */
function judgeItemText(item: AcceptanceItem): string {
  if (item.kind === "instructions") {
    return "the task is done as instructed (its instructions are above)";
  }
  if (item.kind === "request") {
    return "every exact name, message, output line, format and value the user's request fixes for this task's part is used verbatim";
  }
  return item.text;
}

/** One task as a judge prompt shows it. */
export interface JudgePromptTask {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: readonly ItemVerdict[];
  /** `renderRuntimeRecord`'s text, when the runtime recorded the workers. */
  record?: string;
}

const RECORD_HEADING = "## Recorded by the runtime (";

/**
 * The prompt of one judge call. One task reads as before; several share
 * one preamble, one copy of the user's request and one evidence block,
 * and each item is named `<task>:<item>` so the answer cannot mix them up.
 * The answer lists only the red items with a reason; the rest are named.
 */
export function renderJudgeCallPrompt(input: {
  tasks: readonly JudgePromptTask[];
  evidence: string;
  /** The user's original request, of which every task is one part. */
  originalRequest?: string;
}): string {
  const many = input.tasks.length > 1;
  const key = (taskId: string, itemId: string): string =>
    many ? `${taskId}:${itemId}` : itemId;
  const request = input.originalRequest?.trim() ?? "";
  const withRecord = input.tasks.some((t) => t.record !== undefined);
  const taskBlock = (t: JudgePromptTask): string[] => {
    const judged = t.items.filter((item) => !t.facts.some((fact) => fact.id === item.id));
    const sub = many ? "###" : "##";
    return [
      many ? `## Task ${t.task.id}` : "## Task",
      t.task.instructions.slice(0, 4_000),
      "",
      `${sub} Items to rule on`,
      ...judged.map((item) => `- ${key(t.task.id, item.id)}: ${judgeItemText(item)}`),
      "",
      `${sub} Already established by scripts (for context; not yours to change)`,
      ...(t.facts.length === 0
        ? ["(none)"]
        : t.facts.map(
            (f) => `- ${key(t.task.id, f.id)}: ${f.pass ? "met" : "NOT met"} — ${f.why}`,
          )),
      "",
    ];
  };
  const first = input.tasks[0]?.task.id ?? "t";
  const [red, pass] = [key(first, "a1"), key(first, "a2")];
  return [
    many
      ? `You are a strict acceptance judge. Workers say they finished the ${input.tasks.length} tasks below, each one part of the same job. Do not trust them: find where the work does NOT meet each item. Rule on each task's items against that task's instructions, only from the evidence shown. If the evidence does not show an item is met, it is not met.`
      : "You are a strict acceptance judge. A worker says it finished the task below. Do not trust it: find where the work does NOT meet each item. Rule only from the evidence shown. If the evidence does not show an item is met, it is not met.",
    JUDGE_SEVERITY_RULE,
    ...(withRecord
      ? [
          many
            ? "A step of process — running a command, its result, which files were written — is shown by the runtime's record for that task at the end, not by the files."
            : "A step of process — running a command, its result, which files were written — is shown by the runtime's record at the end, not by the files.",
        ]
      : []),
    ...(request.length === 0
      ? []
      : [
          many
            ? "The tasks were briefed from the user's original request, shown first. Where that request fixes an exact name, message, output line, format or value for what a task builds, the work must match it character for character; the task's own wording does not override it. Rule on each task only for its part of the request."
            : "The task was briefed from the user's original request, shown first. Where that request fixes an exact name, message, output line, format or value for what this task builds, the work must match it character for character; the task's own wording does not override it. Rule only on this task's part of the request.",
          "",
          many
            ? "## The user's original request (each task is one part of it)"
            : "## The user's original request (this task is one part of it)",
          request.length > JUDGE_REQUEST_CHARS
            ? `${request.slice(0, JUDGE_REQUEST_CHARS)}[…]`
            : request,
        ]),
    "",
    ...input.tasks.flatMap(taskBlock),
    "## Evidence",
    input.evidence,
    "",
    ...input.tasks.flatMap((t) =>
      t.record === undefined
        ? []
        : [
            many
              ? t.record.replace(RECORD_HEADING, `## Recorded by the runtime for task ${t.task.id} (`)
              : t.record,
            "",
          ],
    ),
    `Answer with JSON only: {"red":[{"id":"${red}","why":"one line: what is wrong"}],"pass":["${pass}"]} — every item to rule on in exactly one of the two lists; a reason only for a red item.`,
  ].join("\n");
}

/** One task's judge prompt (`renderJudgeCallPrompt` with one task). */
export function renderJudgePrompt(input: {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: readonly ItemVerdict[];
  evidence: string;
  /** `renderRuntimeRecord`'s text, when the runtime recorded the workers. */
  record?: string;
  /** The user's original request, of which this task is one part. */
  originalRequest?: string;
}): string {
  return renderJudgeCallPrompt({
    tasks: [
      {
        task: input.task,
        items: input.items,
        facts: input.facts,
        ...(input.record === undefined ? {} : { record: input.record }),
      },
    ],
    evidence: input.evidence,
    ...(input.originalRequest === undefined
      ? {}
      : { originalRequest: input.originalRequest }),
  });
}

/**
 * Per-item verdicts from the judge's answer; `null` when it cannot be read
 * at all. Reads the compact form `{"red":[{id,why}],"pass":[id]}` and the
 * older `{"items":[{id,pass,why}]}`. An id named both red and passed is
 * red, and in the older form only a literal `pass: true` passes.
 */
export function parseJudgeAnswer(
  content: string,
): Map<string, { pass: boolean; why: string }> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { items, red, pass } = parsed as Record<string, unknown>;
  if (!Array.isArray(items) && !Array.isArray(red) && !Array.isArray(pass)) return null;
  const reason = (why: unknown): string =>
    typeof why === "string" && why.trim().length > 0 ? why.trim() : "no reason given";
  const idOf = (entry: unknown): string | undefined => {
    if (typeof entry === "string") return entry;
    if (entry !== null && typeof entry === "object") {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
    return undefined;
  };
  const out = new Map<string, { pass: boolean; why: string }>();
  for (const entry of Array.isArray(items) ? items : []) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, pass: ok, why } = entry as Record<string, unknown>;
    if (typeof id !== "string") continue;
    out.set(id, { pass: ok === true, why: reason(why) });
  }
  for (const entry of Array.isArray(pass) ? pass : []) {
    const id = idOf(entry);
    if (id !== undefined && out.get(id)?.pass !== false) out.set(id, { pass: true, why: "met" });
  }
  for (const entry of Array.isArray(red) ? red : []) {
    const id = idOf(entry);
    if (id === undefined) continue;
    const why = entry !== null && typeof entry === "object"
      ? (entry as Record<string, unknown>).why
      : undefined;
    out.set(id, { pass: false, why: reason(why) });
  }
  return out;
}

export interface JudgeTarget {
  providerId: string;
  model: string | null;
}

/** What one judge call shares across its tasks. */
export interface JudgeCallInput {
  facts: JudgeFacts;
  contract: DelegateContract | undefined;
  workingDir: string;
  target: JudgeTarget;
  pricing: WorkerPricing | undefined;
  complete: EscalationComplete;
  signal: AbortSignal;
  /** The user's original request, of which every task is one part. */
  originalRequest?: string;
}

/** One task a judge call rules on. */
export interface JudgeEntry {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  reply: string;
  /** The runtime's record of the task's workers, when it has one. */
  record?: JudgeRecord;
}

/**
 * Rule on one task's list. Never throws; a judge that cannot run or
 * answer leaves the task unverified, which is not green.
 */
export async function judgeTask(input: JudgeCallInput & JudgeEntry): Promise<JudgeVerdict> {
  const { task, items, reply, record, ...call } = input;
  const verdicts = await judgeTasks({
    ...call,
    entries: [{ task, items, reply, ...(record === undefined ? {} : { record }) }],
  });
  return verdicts.get(task.id)!;
}

/**
 * Rule on several tasks' lists in one judge call (one fan-out's round):
 * the preamble, the user's request and shared files are paid for once,
 * not once per task. Facts are settled per task first; a task with a red
 * fact or nothing left to judge is not asked. The call's cost is split
 * evenly over the tasks it asked. Never throws: a call that cannot run or
 * answer leaves every task it asked unverified. Verdicts come back in
 * the entries' order, keyed by task id.
 */
export async function judgeTasks(
  input: JudgeCallInput & { entries: readonly JudgeEntry[] },
): Promise<Map<string, JudgeVerdict>> {
  const settled = new Map<string, JudgeVerdict>();
  const asked: Array<{ entry: JudgeEntry; facts: ItemVerdict[]; needs: AcceptanceItem[] }> = [];
  for (const entry of input.entries) {
    const facts: ItemVerdict[] = [];
    for (const item of entry.items) {
      const verdict = await factVerdict(item, input.facts, input.workingDir);
      if (verdict !== undefined) facts.push(verdict);
    }
    const needs = entry.items.filter((item) => !facts.some((fact) => fact.id === item.id));
    // A red fact makes the list red whatever the judge would say, so the
    // judge is not paid to say it; its items are listed as not judged.
    if (needs.length === 0 || facts.some((v) => !v.pass)) {
      const skipped = needs.map(
        (item): ItemVerdict => ({
          id: item.id,
          pass: false,
          why: "not judged: a scripted item is already red",
          by: "skipped",
        }),
      );
      settled.set(entry.task.id, {
        green: facts.every((v) => v.pass) && skipped.length === 0,
        items: [...facts, ...skipped].sort((a, b) => itemOrder(a.id) - itemOrder(b.id)),
        costUsd: null,
      });
      continue;
    }
    asked.push({ entry, facts, needs });
  }
  const inOrder = (): Map<string, JudgeVerdict> =>
    new Map(input.entries.map((e) => [e.task.id, settled.get(e.task.id)!]));
  if (asked.length === 0) return inOrder();

  const evidence = await gatherBatchEvidence(
    asked.map((a) => a.entry),
    input.contract,
    input.workingDir,
  );
  const prompt = renderJudgeCallPrompt({
    tasks: asked.map(({ entry, facts }) => ({
      task: entry.task,
      items: entry.items,
      facts,
      ...(entry.record === undefined
        ? {}
        : { record: renderRuntimeRecord(entry.record, input.workingDir) }),
    })),
    evidence,
    ...(input.originalRequest === undefined ? {} : { originalRequest: input.originalRequest }),
  });
  let content: string | undefined;
  let costUsd: number | null = null;
  let failure: string | undefined;
  try {
    const answer = await input.complete({
      providerId: input.target.providerId,
      prompt,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS * Math.min(asked.length, 3),
      signal: input.signal,
    });
    content = answer.content;
    if (input.pricing !== undefined && answer.usage !== undefined) {
      costUsd = estimateUsageCostUsd(answer.usage, input.pricing);
    }
  } catch (err) {
    failure = `the judge could not run: ${err instanceof Error ? err.message : String(err)}`;
  }
  const share = costUsd === null ? null : costUsd / asked.length;
  const ruled = content === undefined ? null : parseJudgeAnswer(content);
  if (ruled === null) failure ??= "the judge's answer could not be read";
  const many = asked.length > 1;
  for (const { entry, facts, needs } of asked) {
    if (ruled === null) {
      settled.set(entry.task.id, {
        green: false,
        items: facts,
        unverified: failure!,
        costUsd: share,
      });
      continue;
    }
    const judged = needs.map((item): ItemVerdict => {
      const verdict = ruled.get(many ? `${entry.task.id}:${item.id}` : item.id);
      return verdict === undefined
        ? { id: item.id, pass: false, why: "the judge gave no verdict", by: "judge" }
        : { id: item.id, ...verdict, by: "judge" };
    });
    const all = [...facts, ...judged].sort((a, b) => itemOrder(a.id) - itemOrder(b.id));
    settled.set(entry.task.id, { green: all.every((v) => v.pass), items: all, costUsd: share });
  }
  return inOrder();
}

function itemOrder(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

/** The items found not met; a skipped item is not a finding. */
export function redItems(verdict: JudgeVerdict): ItemVerdict[] {
  return verdict.items.filter((v) => !v.pass && v.by !== "skipped");
}

/** The findings a retried worker is briefed with. */
export function renderRetryFindings(
  items: readonly AcceptanceItem[],
  verdict: JudgeVerdict,
): string {
  return [
    "## A judge found these acceptance items NOT met in your previous attempt",
    ...redItems(verdict).map((v) => {
      const item = items.find((i) => i.id === v.id);
      return `- [${v.id}] ${item?.text ?? ""} — ${v.why}`;
    }),
    "Fix exactly these. The files from the previous attempt are on disk; change them rather than starting over.",
  ].join("\n");
}

export interface JudgeSummary {
  green: boolean;
  total: number;
  failed: number;
  retried: boolean;
  unverified?: string;
  costUsd: number | null;
  items: ItemVerdict[];
}

/** A verdict as the row's `judge` field carries it. */
export function judgeSummary(verdict: JudgeVerdict, retried: boolean): JudgeSummary {
  return {
    green: verdict.green,
    total: verdict.items.length,
    failed: redItems(verdict).length,
    retried,
    ...(verdict.unverified === undefined ? {} : { unverified: verdict.unverified }),
    costUsd: verdict.costUsd,
    items: verdict.items,
  };
}

/** The red items as one line: `a2 why; a5 why`. */
export function renderRedItems(verdict: JudgeVerdict): string {
  return redItems(verdict)
    .map((v) => `${v.id} ${v.why}`)
    .join("; ");
}

/** Fold a verdict into the task's row: a node closes only on a green list. */
export function applyJudgeVerdict(
  result: WorkerTaskResult,
  verdict: JudgeVerdict,
  retried: boolean,
): WorkerTaskResult {
  const red = redItems(verdict);
  const summary = judgeSummary(verdict, retried);
  const after = retried ? " after one retry" : "";
  if (verdict.unverified !== undefined) {
    return {
      ...result,
      status: "needs_orchestrator",
      judge: summary,
      notes: [
        ...(result.notes ?? []),
        `judge: not verified${after} — ${verdict.unverified}; the task stays open`,
      ],
    };
  }
  if (verdict.green) {
    return {
      ...result,
      judge: summary,
      notes: [
        ...(result.notes ?? []),
        `judge: all ${verdict.items.length} acceptance items green${after}`,
      ],
    };
  }
  const detail = renderRedItems(verdict);
  const skipped = verdict.items.length - verdict.items.filter((v) => v.by !== "skipped").length;
  const error = `judge: ${red.length} of ${verdict.items.length} acceptance items not met${after} — ${detail}${skipped > 0 ? ` (${skipped} not judged)` : ""}`;
  return {
    ...result,
    status: "failed",
    judge: summary,
    error: result.error === undefined ? error : `${error}; ${result.error}`,
  };
}
