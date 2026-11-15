import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { structuredPatch } from "diff";
import { JUDGE_FIXED_PART_END } from "../../llm/provider/subscription-cli/cli-session-chain.js";
import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import type { FileSnapshot } from "./autoverify.js";
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
 *
 * What a judge call costs is mostly what it writes to the provider's
 * cache (k3b/k3c, 16-11-2026: 0.39-0.43 of a Claude-only run in three
 * calls). So the rules are one fixed text before `JUDGE_FIXED_PART_END`,
 * which a vendor CLI keeps as its session's system prompt; a file the
 * work changed is shown as a diff against its text from before the work
 * (`gatherJudgeEvidence`); and the retry round is a follow-up to the
 * first round's prompt in the same CLI session (`JudgeSession`), so the
 * first round is read back from cache and only the changes are new.
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
 * A changed or unchanged file up to this size is shown whole; a larger
 * changed file as a diff, a larger unchanged one by name only.
 */
export const JUDGE_WHOLE_FILE_CHARS = 3_000;
/**
 * Lines of context around each change in a diff. Wide on purpose: a
 * diff can hide what is missing, and the judge rules on omissions too.
 */
export const JUDGE_DIFF_CONTEXT_LINES = 12;
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

/**
 * Every path the judge may read for these tasks: snapshot them before the
 * work starts (`snapshotFiles`), so the judge is shown what changed.
 */
export function judgeEvidencePaths(
  tasks: readonly DelegateTask[],
  contract: DelegateContract | undefined,
): string[] {
  return tasks
    .flatMap((task) => declaredPaths(task, contract))
    .filter((p, i, all) => all.indexOf(p) === i);
}

/** A path as `snapshotFiles` keys it. */
function snapshotKey(path: string, workingDir: string): string {
  return relative(workingDir, absolute(path, workingDir)).split("\\").join("/");
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

/** Every file whole, as when there is nothing to compare with. */
export async function gatherBatchEvidence(
  entries: ReadonlyArray<{ task: DelegateTask; reply: string }>,
  contract: DelegateContract | undefined,
  workingDir: string,
): Promise<string> {
  return (await gatherJudgeEvidence(entries, contract, workingDir)).text;
}

/** What the evidence of a file is compared with (`gatherJudgeEvidence`). */
export interface EvidenceBaseline {
  /** The files' text before the work (`snapshotFiles`; `null`: absent). */
  before?: ReadonlyMap<string, string | null>;
  /**
   * A follow-up round: the files' text as the judge read it last round.
   * A path in here is compared with this instead of `before`.
   */
  read?: ReadonlyMap<string, string | null>;
}

export interface JudgeEvidence {
  text: string;
  /** Each file's text as read now, keyed like `snapshotFiles` (`null`: missing). */
  seen: FileSnapshot;
}

/**
 * The evidence of one judge call over several tasks: every declared file
 * once, however many tasks name it (two tasks that both touch `models.py`
 * do not pay for it twice). A task that declared no files is judged on its
 * reply. All of it shares one budget, which grows by
 * `JUDGE_EVIDENCE_EXTRA_CHARS` for each task after the first, up to twice
 * the one-task budget.
 *
 * With a baseline a file is shown by what the work did to it: a new file
 * whole; a changed file whole when short, else as a diff; an unchanged
 * one whole when short, else by name only (`fileEvidence`). A path the
 * baseline does not know is shown whole, as without one.
 */
export async function gatherJudgeEvidence(
  entries: ReadonlyArray<{ task: DelegateTask; reply: string }>,
  contract: DelegateContract | undefined,
  workingDir: string,
  baseline: EvidenceBaseline = {},
): Promise<JudgeEvidence> {
  const single = entries.length === 1;
  const keys = new Set<string>();
  const paths: string[] = [];
  for (const path of entries.flatMap((e) => declaredPaths(e.task, contract))) {
    const key = absolute(path, workingDir).toLowerCase();
    if (keys.has(key)) continue;
    keys.add(key);
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
  const seen: FileSnapshot = new Map();
  const blocks: EvidenceBlock[] = [
    ...entries
      .filter((e) => declaredPaths(e.task, contract).length === 0)
      .map((e) => ({
        head: single
          ? "This task declared no files, so its reply is the deliverable. Judge what the reply contains, not what it says it did elsewhere.\n### reply"
          : `Task ${e.task.id} declared no files, so its reply is its deliverable. Judge what the reply contains, not what it says it did elsewhere.\n### reply of task ${e.task.id}`,
        body: e.reply,
      })),
    ...paths.map((path, i) => {
      const key = snapshotKey(path, workingDir);
      const now = bodies[i];
      seen.set(key, now ?? null);
      return fileEvidence(path, now, key, baseline);
    }),
  ];
  const budget = Math.min(
    2 * JUDGE_EVIDENCE_CHARS,
    JUDGE_EVIDENCE_EXTRA_CHARS * Math.max(0, entries.length - 1) + JUDGE_EVIDENCE_CHARS,
  );
  const caps = shareEvidenceBudget(
    blocks.map((b) => b.body?.length ?? 0),
    budget,
  );
  const text = blocks
    .map((block, i) => {
      if (block.bare === true) return block.head;
      if (block.body === undefined) return `${block.head}\n[missing]`;
      const cap = caps[i]!;
      const shown =
        block.body.length > cap
          ? `${block.body.slice(0, cap)}\n[… ${block.body.length - cap} more chars clipped]`
          : block.body;
      return `${block.head}\n${shown}`;
    })
    .join("\n\n");
  return { text, seen };
}

interface EvidenceBlock {
  head: string;
  /** `undefined`: the file is missing. */
  body: string | undefined;
  /** Only the heading: the file is named, not shown. */
  bare?: true;
}

/** One file as the judge reads it, by what the work did to it. */
function fileEvidence(
  path: string,
  now: string | undefined,
  key: string,
  baseline: EvidenceBaseline,
): EvidenceBlock {
  if (now === undefined) return { head: `### ${path}`, body: undefined };
  const followUp = baseline.read?.has(key) === true;
  const reference = followUp ? baseline.read : baseline.before;
  if (reference === undefined || !reference.has(key)) {
    return { head: `### ${path}`, body: now };
  }
  const was = reference.get(key) ?? null;
  const since = followUp ? "since your ruling" : "by this work";
  if (was === null) {
    return { head: `### ${path} (${followUp ? "new since your ruling" : "new file"})`, body: now };
  }
  const count = now.split("\n").length - (now.endsWith("\n") ? 1 : 0);
  const lines = `${count} line${count === 1 ? "" : "s"}`;
  if (was === now) {
    // A follow-up does not show again what the judge has just read.
    return followUp || now.length > JUDGE_WHOLE_FILE_CHARS
      ? { head: `### ${path} — unchanged ${since} (${lines}, not shown)`, body: "", bare: true }
      : { head: `### ${path} (unchanged ${since})`, body: now };
  }
  if (now.length <= JUDGE_WHOLE_FILE_CHARS) {
    return { head: `### ${path} (changed ${since}, shown whole)`, body: now };
  }
  const diff = renderFileDiff(path, was, now);
  return diff.length >= now.length
    ? { head: `### ${path} (changed ${since}, shown whole)`, body: now }
    : { head: `### ${path} (changed ${since}: diff, ${lines} now)`, body: diff };
}

/** The change from `was` to `now` as unified hunks, without file headers. */
function renderFileDiff(path: string, was: string, now: string): string {
  const patch = structuredPatch(path, path, was, now, undefined, undefined, {
    context: JUDGE_DIFF_CONTEXT_LINES,
  });
  return patch.hunks
    .map((hunk) =>
      [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      ].join("\n"),
    )
    .join("\n");
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
 * The judge's rules: the same bytes in every judge call, one task or
 * many, first round or follow-up, so a vendor CLI keeps them as the
 * system prompt it reads from cache (`JUDGE_FIXED_PART_END`). Nothing
 * here may depend on the case.
 */
export const JUDGE_RULES = [
  "You are a strict acceptance judge. Workers say they finished the task or tasks in the case below. Do not trust them: find where the work does NOT meet each item. Rule on each task's items against that task's instructions, only from the evidence shown. If the evidence does not show an item is met, it is not met.",
  JUDGE_SEVERITY_RULE,
  "A step of process — running a command, its result, which files were written — is shown by the runtime's record for that task at the end of the case, not by the files.",
  "When the case shows the user's original request, the tasks were briefed from it. Where that request fixes an exact name, message, output line, format or value for what a task builds, the work must match it character for character; the task's own wording does not override it. Rule on each task only for its part of the request.",
  "How the evidence shows a file: a new file whole; a changed file whole when it is short, otherwise as a diff of what the work changed (`+` added, `-` removed, unmarked lines are context) — the parts of it the diff does not show are as they were before the work; an unchanged file whole when it is short, otherwise only by name. An item that needs a change the evidence does not show is not met.",
  // Every defect at once: k3b's first round named only "Tilføjet", the
  // retry fixed it, and the second round then failed the same item for
  // argparse's exit 2, which had been there all along — a second round,
  // a red task and a new delegation for one defect (16-11-2026). Each
  // defect once: k3c's answers repeated one defect under every item it
  // touched, and output is the dearest token there is.
  `Answer with JSON only: {"red":[{"id":"<item id>","why":"one line: every defect in this item, joined by '; '"}],"pass":["<item id>"]} — every item to rule on in exactly one of the two lists; a reason only for a red item. Name all of a red item's defects now: the worker gets one retry, and a defect left out is found only after it. Name each defect once, under the first item it fails, in at most about 20 words; another item that fails for the same defect says only "same as <id>".`,
].join("\n");

function itemKey(qualified: boolean): (taskId: string, itemId: string) => string {
  return (taskId, itemId) => (qualified ? `${taskId}:${itemId}` : itemId);
}

/** The items a task's judge rules on: those no script settled. */
function judgedItems(t: JudgePromptTask): AcceptanceItem[] {
  return t.items.filter((item) => !t.facts.some((fact) => fact.id === item.id));
}

function renderFacts(
  t: JudgePromptTask,
  key: (taskId: string, itemId: string) => string,
): string[] {
  return t.facts.length === 0
    ? ["(none)"]
    : t.facts.map((f) => `- ${key(t.task.id, f.id)}: ${f.pass ? "met" : "NOT met"} — ${f.why}`);
}

/**
 * The prompt of one judge call: `JUDGE_RULES`, then the case after
 * `JUDGE_FIXED_PART_END`. One task reads as before; several share one
 * copy of the user's request and one evidence block, and each item is
 * named `<task>:<item>` so the answer cannot mix them up. The answer
 * lists only the red items with a reason; the rest are named.
 */
export function renderJudgeCallPrompt(input: {
  tasks: readonly JudgePromptTask[];
  evidence: string;
  /** The user's original request, of which every task is one part. */
  originalRequest?: string;
  /**
   * Name items `<task>:<item>`; by default when there are several tasks.
   * A follow-up keeps the form its first round used (`JudgeSession`).
   */
  qualified?: boolean;
}): string {
  const many = input.tasks.length > 1;
  const qualified = input.qualified ?? many;
  const key = itemKey(qualified);
  const request = input.originalRequest?.trim() ?? "";
  const taskBlock = (t: JudgePromptTask): string[] => {
    const sub = qualified ? "###" : "##";
    return [
      qualified ? `## Task ${t.task.id}` : "## Task",
      t.task.instructions.slice(0, 4_000),
      "",
      `${sub} Items to rule on`,
      ...judgedItems(t).map((item) => `- ${key(t.task.id, item.id)}: ${judgeItemText(item)}`),
      "",
      `${sub} Already established by scripts (for context; not yours to change)`,
      ...renderFacts(t, key),
      "",
    ];
  };
  return [
    JUDGE_RULES,
    "",
    JUDGE_FIXED_PART_END.trimStart(),
    (many
      ? `Workers say they finished the ${input.tasks.length} tasks below, each one part of the same job.`
      : "A worker says it finished the task below.") +
      (qualified ? " An item's id is <task>:<item>." : ""),
    ...(request.length === 0
      ? []
      : [
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
            qualified
              ? t.record.replace(RECORD_HEADING, `## Recorded by the runtime for task ${t.task.id} (`)
              : t.record,
            "",
          ],
    ),
    "Answer now with the JSON only, in the form given above; use the item ids exactly as listed.",
  ].join("\n");
}

/** A task in a follow-up round, with its ruling from the round before. */
export interface JudgeFollowUpTask extends JudgePromptTask {
  /** Absent: the task was not ruled on before (a script item was red). */
  earlier?: JudgeVerdict;
}

/**
 * What a retry round appends to the round before's prompt. The judge has
 * read that round's case and given its answer in the same CLI session, so
 * this shows only what is new: per task its findings, the items to rule
 * on again and the scripts' results; the files as they changed since that
 * ruling (`gatherJudgeEvidence` with `read`); the retry's record. It opens
 * with a `## ` heading, so the session chain reads it as more of the case
 * rather than a side text.
 */
export function renderJudgeFollowUp(input: {
  tasks: readonly JudgeFollowUpTask[];
  evidence: string;
  qualified: boolean;
}): string {
  const key = itemKey(input.qualified);
  const taskBlock = (t: JudgeFollowUpTask): string[] => {
    const heading = input.qualified ? `### Task ${t.task.id}` : "### The task";
    const items = judgedItems(t).map(
      (item) => `- ${key(t.task.id, item.id)}: ${judgeItemText(item)}`,
    );
    if (t.earlier === undefined) {
      return [
        heading,
        "Not ruled on by you before. Its instructions:",
        t.task.instructions.slice(0, 4_000),
        "",
        "Items to rule on:",
        ...items,
        "",
        "Established by scripts (not yours to change):",
        ...renderFacts(t, key),
        "",
      ];
    }
    const findings = t.earlier.items.filter((v) => !v.pass && v.by === "judge");
    return [
      heading,
      "Your findings, which the worker was told to fix:",
      ...(findings.length === 0
        ? ["(none)"]
        : findings.map((v) => `- ${key(t.task.id, v.id)}: ${v.why}`)),
      "",
      "Items to rule on again:",
      ...items,
      "",
      "Established by scripts after the retry (not yours to change):",
      ...renderFacts(t, key),
      "",
    ];
  };
  return [
    "",
    "## Follow-up: the workers retried",
    "Each task below was run once more, with the findings it was given. Rule again on the items listed under it, from the changes shown here and what you read above. An item you passed stays met unless a change breaks it; an item you failed is met only when a change fixes every defect you named in it.",
    "",
    ...input.tasks.flatMap(taskBlock),
    "### Changes since your ruling",
    input.evidence,
    "",
    ...input.tasks.flatMap((t) =>
      t.record === undefined
        ? []
        : [
            t.record.replace(
              RECORD_HEADING,
              input.qualified
                ? `### Recorded by the runtime for task ${t.task.id} after the retry (`
                : "### Recorded by the runtime after the retry (",
            ),
            "",
          ],
    ),
    "Answer now with the JSON only, in the form given above, for the items to rule on again; use their ids exactly as listed.",
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

/** A round the judge answered, which the next round follows up on. */
export interface JudgeRound {
  /** The round's prompt as sent, without the judge's answer. */
  prompt: string;
  /** The files as the judge has read them, by `snapshotFiles` key. */
  seen: FileSnapshot;
  qualified: boolean;
  /** The tasks the judge has ruled on. */
  asked: ReadonlySet<string>;
  verdicts: ReadonlyMap<string, JudgeVerdict>;
}

/**
 * One `fusion.delegate` call's judge across its rounds. Every round sends
 * `key` as the CLI session to continue (`cliSessionKey`), and a round after
 * the first appends a follow-up (`renderJudgeFollowUp`) to the prompt of
 * `last`, so the provider resumes the session and reads that round from
 * cache. `judgeTasks` keeps `last`.
 */
export interface JudgeSession {
  key?: string;
  last?: JudgeRound;
}

/**
 * Rule on several tasks' lists in one judge call (one fan-out's round):
 * the preamble, the user's request and shared files are paid for once,
 * not once per task. Facts are settled per task first; a task with a red
 * fact or nothing left to judge is not asked. The call's cost is split
 * evenly over the tasks it asked. Never throws: a call that cannot run or
 * answer leaves every task it asked unverified. Verdicts come back in
 * the entries' order, keyed by task id.
 *
 * `before` is the declared files' text from before the work, so a file
 * is shown by what the work did to it; `session` makes a later round a
 * follow-up to the last one it answered.
 */
export async function judgeTasks(
  input: JudgeCallInput & {
    entries: readonly JudgeEntry[];
    before?: FileSnapshot;
    session?: JudgeSession;
  },
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

  const last = input.session?.last;
  const qualified = asked.length > 1 || last?.qualified === true;
  const evidence = await gatherJudgeEvidence(
    asked.map((a) => a.entry),
    input.contract,
    input.workingDir,
    {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(last === undefined ? {} : { read: last.seen }),
    },
  );
  const tasks = asked.map(({ entry, facts }): JudgePromptTask => ({
    task: entry.task,
    items: entry.items,
    facts,
    ...(entry.record === undefined
      ? {}
      : { record: renderRuntimeRecord(entry.record, input.workingDir) }),
  }));
  const prompt =
    last === undefined
      ? renderJudgeCallPrompt({
          tasks,
          evidence: evidence.text,
          qualified,
          ...(input.originalRequest === undefined
            ? {}
            : { originalRequest: input.originalRequest }),
        })
      : `${last.prompt}\n${renderJudgeFollowUp({
          tasks: tasks.map((t) => {
            const earlier = last.asked.has(t.task.id) ? last.verdicts.get(t.task.id) : undefined;
            return earlier === undefined ? t : { ...t, earlier };
          }),
          evidence: evidence.text,
          qualified,
        })}`;
  let content: string | undefined;
  let costUsd: number | null = null;
  let failure: string | undefined;
  try {
    const answer = await input.complete({
      providerId: input.target.providerId,
      prompt,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS * Math.min(asked.length, 3),
      signal: input.signal,
      ...(input.session?.key === undefined ? {} : { cliSessionKey: input.session.key }),
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
      const verdict = ruled.get(qualified ? `${entry.task.id}:${item.id}` : item.id);
      return verdict === undefined
        ? { id: item.id, pass: false, why: "the judge gave no verdict", by: "judge" }
        : { id: item.id, ...verdict, by: "judge" };
    });
    const all = [...facts, ...judged].sort((a, b) => itemOrder(a.id) - itemOrder(b.id));
    settled.set(entry.task.id, { green: all.every((v) => v.pass), items: all, costUsd: share });
  }
  if (input.session !== undefined && ruled !== null) {
    const seen: FileSnapshot = new Map(last?.seen ?? []);
    for (const [path, text] of evidence.seen) seen.set(path, text);
    const verdicts = new Map(last?.verdicts ?? []);
    for (const { entry } of asked) verdicts.set(entry.task.id, settled.get(entry.task.id)!);
    input.session.last = {
      prompt,
      seen,
      qualified,
      asked: new Set([...(last?.asked ?? []), ...asked.map((a) => a.entry.task.id)]),
      verdicts,
    };
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
