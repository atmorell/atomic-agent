import {
  isStoppedTurnMarker,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import {
  ORIGINAL_REQUEST_BEGIN_MARKER,
  ORIGINAL_REQUEST_END_MARKER,
  REQUEST_FOLLOW_UP_MARKER,
} from "../../prompt/request-section.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  renderContractBlock,
  renderContractForTask,
  type DelegateContract,
} from "./contract.js";
import {
  FUSION_WORKER_APPROVAL_MARKER,
  FUSION_WORKER_OPERATOR_ONLY_MARKER,
} from "./worker-tool-policy.js";

/**
 * The single user message a fusion worker turn is started with.
 *
 * A worker is a fresh session: no transcript, no memory recall, no
 * operator. Everything it is allowed to assume has to be in this one
 * string, which is why `renderWorkerBrief` spells out the frame ("you
 * are a worker, you have no memory of the parent conversation") rather
 * than leaving the model to infer it from an instruction that reads
 * like the middle of a conversation.
 *
 * The three rules at the bottom exist because a worker's failure modes
 * are not a normal turn's. It cannot ask a question — nobody is
 * watching its session — so "never ask, act on the most reasonable
 * reading" replaces the usual clarification path. It cannot get an
 * approval, so the refusal marker gets an explicit handling rule that
 * turns a dead end into a hand-back. And its reply is not shown to a
 * person: it is pasted into the orchestrator's tool result, so it must
 * be a result, not a status report, and it must fit the budget the
 * orchestrator's own context can carry.
 */
export const WORKER_REPLY_CHAR_BUDGET = 4000;

/**
 * How much of the operator's original request a brief quotes.
 *
 * Why the request is quoted at all: a brief is the orchestrator's
 * summary, and summaries were thin (124–901 chars in one benchmark). A
 * worker told "write index.html and style.css, match all visual and
 * structural requirements" built a marketing landing page instead of the
 * game the operator asked for, and workers with thin briefs spent 30–40
 * steps reverse-engineering sibling modules off the disk. The request is
 * the one text every part of the job must agree with, so every worker
 * gets it — labelled as context, with its own task below.
 *
 * Bounded because every worker pays for it in its slot's context:
 * 16,000 chars is roughly 4K tokens, a real spec with room to spare,
 * and a request longer than that is clipped with a note saying so.
 */
export const ORIGINAL_REQUEST_CHAR_BUDGET = 16_000;

/**
 * A turn-starting message shorter than this is read as a follow-up
 * ("continue", "fix the failing test") rather than as the request
 * itself, so the brief quotes the message before it as well.
 */
export const FOLLOW_UP_MAX_CHARS = 280;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The request to quote in the briefs of a turn's fan-outs.
 *
 * `current` is the message that started the parent turn;
 * `earlierTurns` is the parent transcript as it stood before it. A
 * turn started without a message (a task runner resuming) falls back to
 * the last thing the operator said; a short follow-up is quoted together
 * with the message it follows up, because "continue" alone tells a
 * worker nothing about what is being continued.
 *
 * Except a message the user stopped (a stop marker after it): that
 * request was withdrawn, so it is neither merged into a short message
 * nor fallen back to. Merged, "how are you?" after a stopped "write 100
 * names" reached every worker as ORIGINAL REQUEST with the stopped job
 * in it, and the orchestrator delegated the stopped job again.
 */
export function pickOriginalRequest(input: {
  current: string;
  earlierTurns: readonly ConversationTurn[];
}): string | undefined {
  const previous = lastLiveRequest(input.earlierTurns);
  const current = input.current.trim();
  if (current.length === 0) return previous;
  if (current.length >= FOLLOW_UP_MAX_CHARS || previous === undefined) {
    return current;
  }
  return `${previous}\n\n${REQUEST_FOLLOW_UP_MARKER}\n${current}`;
}

/**
 * The last non-empty thing the operator said before this turn, unless a
 * stop marker follows it — then nothing: the user stopped that request.
 */
function lastLiveRequest(
  turns: readonly ConversationTurn[],
): string | undefined {
  let stopped = false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (isStoppedTurnMarker(turn)) {
      stopped = true;
      continue;
    }
    if (turn === undefined || turn.kind !== "user") continue;
    const text = turn.text.trim();
    if (text.length === 0) continue;
    return stopped ? undefined : text;
  }
  return undefined;
}

function quoteOriginalRequest(request: string): string[] {
  const clipped =
    request.length > ORIGINAL_REQUEST_CHAR_BUDGET
      ? request.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET)
      : request;
  const lines = [
    `ORIGINAL REQUEST — context only; your task is below. This is the operator's whole job, which the orchestrator split across several workers. Use it for the names, formats, constraints and look your part must agree with, and do only your TASK.`,
    ORIGINAL_REQUEST_BEGIN_MARKER,
    clipped,
    ORIGINAL_REQUEST_END_MARKER,
  ];
  if (clipped.length < request.length) {
    lines.push(
      `(truncated: the original request is ${formatCount(request.length)} chars; only the first ${formatCount(ORIGINAL_REQUEST_CHAR_BUDGET)} are quoted above.)`,
    );
  }
  return lines;
}

/**
 * The contract, when the fan-out has one, sits between the request
 * (what the whole job is) and the task (what this worker does): the
 * shared block first, then the three lines that say what it means for
 * this task. Every worker of the fan-out reads the same shared block,
 * which is the point — the names they must agree on are written once,
 * not paraphrased eight times.
 */
function quoteContract(contract: DelegateContract, taskId: string): string[] {
  return [
    renderContractBlock(contract),
    `For TASK ${taskId}:`,
    renderContractForTask(contract, taskId),
  ];
}

/**
 * Workers of one fan-out run side by side, so a file a sibling writes
 * may not exist yet when this worker looks for it. Measured (ATO-919): a
 * worker re-read a neighbour's not-yet-written file until the loop
 * detector stopped it on `read_repeat`, 15.5K tokens on a small GPU.
 * Only a contract `requires` orders tasks into waves; without one there
 * is nothing to wait for, and with one a missing provider has failed.
 * Either way, re-reading cannot make the file appear.
 */
export function siblingFilesRule(hasContract: boolean): string {
  const names = hasContract ? "the CONTRACT and your task" : "your task";
  return `- A file another task of this fan-out writes may not exist yet: workers run at the same time. If a file you did not write is missing, do not read it again, list its directory again or wait for it — build against the names ${names} gives, and say in your reply which file was missing.`;
}

/**
 * Measured (ATO-919): workers "checked" browser JS with `node -e` /
 * `require`, got "Cannot find module" or "document is not defined",
 * and spent steps on an error that says nothing about their code.
 */
export const BROWSER_CODE_RULE =
  "- Code meant for the browser (it uses `window`, `document`, the DOM or `<script>` loading) does not run under node: `node -e`, `require` or `import` of it fails with \"Cannot find module\" or \"document is not defined\", which says nothing about your code. Check its syntax with `verify.syntax` instead of running it.";

/**
 * Measured (ap3c, 15-11-2026): the request and the brief both wrote
 * `gem` and `Tilfoejet`, and both local workers wrote `sem` and
 * `Tilføjet` — a word written without its special letters read as a typo
 * to fix, in the code and in the worker's own tests, which then passed.
 * Only rendered when the brief quotes an original request.
 */
export const EXACT_SPELLING_RULE =
  "- Spell every name, key, command and output string the original request or your task fixes exactly as written there, letter for letter — also where it looks misspelled or is written without special letters (e.g. `oe` for `ø`, `ue` for `ü`). It is deliberate, and the checks compare exact text: never correct, translate or re-accent it, in the code or in your tests.";

/**
 * Measured (k8b, 16-11-2026): the core worker of a six-file package
 * wrote four files six times — two whole-file rewrites, about 10K
 * tokens or 200 s of a 490 s task on a 2-slot GPU, the task that set the
 * fan-out's pace. Its five `os.fs.edit` calls cost a few hundred tokens
 * each. `worker-runner.ts` steers once on the first rewrite as well.
 */
export const EDIT_NOT_REWRITE_RULE =
  "- Change a file you already wrote in this task with `os.fs.edit`, never by writing it whole again: every line written again costs minutes of local generation.";

/**
 * Measured (k8e, 16-11-2026): the core worker wrote a test file to drive
 * its own code; the judge read it as work outside the task and sent the
 * task back, and the retry ran out the ten-minute clock. A script on
 * `os.shell.run`'s `stdin` runs in the working directory, so the
 * worker's modules import, and leaves no file behind.
 */
export const STDIN_SELF_TEST_RULE =
  "- To try your code without a file, run `os.shell.run` with `cmd` `python` (or `node`), `args` `[\"-\"]` and the script in `stdin`: it runs in the working directory, so your modules import. Never write a test or scratch file your task does not ask for.";

/**
 * Measured (k8h, 16-11-2026): the core worker wrote `formel.py` at 119 s
 * and read it back three times before its first run at 303 s. The one
 * wrong character (`r'|(',')'`) was valid Python; only a run showed it,
 * as a TypeError naming the line. `worker-runner.ts` steers once on the
 * first read of a module written since the last run.
 */
export const RUN_BEFORE_REREAD_RULE =
  "- After writing a module, run it once (a short `stdin` script that imports it and calls it) before you read it again: reading back what you just wrote shows what you meant, a run shows what it does.";

/**
 * Measured (k8k, 16-11-2026): the core worker's own stdin self-test
 * printed "chain of 2574, ... 55.88s" and the worker replied done. Every
 * `saet` recomputed the whole sheet (O(n^2)); the facit suite went from
 * 3.6 s to 58.5 s and the judge passed it. A slow pass is a defect.
 */
export const SLOW_PASS_RULE =
  "- A run that passes but takes more than a few seconds on a few thousand items has not passed: find the work redone for every item (such as recomputing everything on each change) and fix it with `os.fs.edit` before you reply.";

/**
 * Measured (k8l, 16-11-2026): the core worker ran every example it was
 * given and replied done, but none summed a range outside a cycle, so
 * `ark.py` had no evaluation for a range; the test worker's suite failed
 * on it. The CLI worker read a corrupt `ark.json` outside its `try`
 * (k8k: `vis a1` gave a traceback, not "Fejl:"). Each cost a second judge
 * round, about 120 s. The given examples are a floor, not the coverage.
 * k8m: the core went green in round one; the CLI never ran an unknown
 * command, so argparse's multi-line usage on stderr went unseen.
 */
export const NAMED_CASES_RULE =
  "- The examples in your task are a minimum. Before you reply, also run each function, operator and error your task names once (for an error: an unknown command or a missing argument, bad input, a missing or corrupt file) and check the whole output, stderr included, is what the task says.";

/** The one steer sent when a worker reads a module it has not run since writing it. */
export function formatRunBeforeRereadSteer(path: string): string {
  return `You are reading ${path} again without having run it since you wrote it. Run it first: one \`os.shell.run\` with a short script on \`stdin\` that imports it and calls the part in doubt. Then read only the lines the error names.`;
}

/**
 * k8p (16-11-2026): the judge's retry worker read `formel.py` six times
 * over six steps (377-445 s) before its first run; the advisor its stall
 * asked could only answer that it had run nothing yet.
 */
export function formatRunFirstSteer(path: string): string {
  return `You are reading ${path} again and have run nothing yet in this task. Run first: one \`os.shell.run\` with a short script on \`stdin\` that calls the case in doubt (the one your task or its findings name). Then read only the lines the error names.`;
}

/** The one steer sent when a worker rewrites a file it wrote itself. */
export function formatRewriteSteer(path: string): string {
  return `You just wrote ${path} whole again although you had already written it in this task. For every further change to a file you wrote, use \`os.fs.edit\` with only the lines that change — a whole-file rewrite costs minutes here.`;
}

/**
 * Measured (k8x, 16-11-2026): the core worker turned its brief's "run
 * these checks first: (a)…(f)" into one step of 16 `os.shell.run` calls
 * — 145 s of local generation, four of them failing — and after its last
 * green run read its own files six times (73 s) before replying. The
 * task's contract checks are already exact commands: `worker-runner.ts`
 * runs them after each step that changed a file and steers the result in
 * before the next step. Rendered only when that is wired.
 */
export const CHECKS_RUN_BY_RUNTIME_RULE =
  "- The runtime runs your task's CHECKS itself after every step that changes a file (once all your FILES exist) and tells you the result before your next step. Do not write or run your own copies of them. When they all pass, your task is done and your next step takes only reply.";

/**
 * The `### notice` of the step after a run where every check of the
 * worker's task passed: that step takes only `reply`/`finish`
 * (`worker-runner.ts`). Measured (k8ag, 16-11-2026): green at 223 s, the
 * core worker then wrote its own tests with wrong asserts and chased them
 * to the 600 s limit; advice to reply closed it in 3 of 7 green runs.
 */
export const CHECKS_GREEN_HOLD_NOTICE =
  "Every check of your task passed: this step takes only reply. Name the files you wrote and what each does.";

/**
 * The `### notice` of the step after a run where every check still
 * failing had failed the same way three times (`stop`, then `silent`):
 * that step takes only `reply`/`finish` (`worker-runner.ts`). The fan-out
 * runs the check again and the judge, seeing its spec and failure, can
 * void it when it contradicts the request. Measured (k8ad, 16-11-2026):
 * the stop advice alone did not close the core worker; it edited against
 * a wrong assert from 282 s to the 600 s limit.
 */
export const CHECKS_STOPPED_HOLD_NOTICE =
  "Every check still failing has failed the same way three times: this step takes only reply. Name the files you wrote and each check you stopped on.";

const CHECK_STEER_SPEC_CHARS = 140;
const CHECK_STEER_MAX_FAILURES = 3;

/** A check as a person would type it: `cmd args…`, else its JSON, clipped. */
function describeCheckSpec(check: Readonly<Record<string, unknown>>): string {
  const { task: _task, ...spec } = check;
  const cmd = typeof spec.cmd === "string" ? spec.cmd : undefined;
  const args = Array.isArray(spec.args)
    ? spec.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const text = cmd === undefined ? JSON.stringify(spec) : [cmd, ...args].join(" ");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CHECK_STEER_SPEC_CHARS
    ? `${flat.slice(0, CHECK_STEER_SPEC_CHARS)}…`
    : flat;
}

/**
 * A failing check's standing after the same failure came back from runs
 * after successive changes (`worker-runner.ts`): the second time it
 * carries a doubt, the third time a stop, after that it is left out.
 * Measured (k8z, 16-11-2026): one wrong assert in the orchestrator's
 * check (`#CYKEL` is right, the check wanted 0) was steered into the core
 * worker 8 times until the run hit its 600 s limit.
 */
export type CheckRepeatState = "doubt" | "stop" | "silent";

export const CHECK_DOUBT_NOTE =
  "Your last change did not move this failure. Compare the failing assert with your task text: if the code is wrong, fix it; if the check asks for something your task text does not, do not edit for it.";
export const CHECK_STOP_NOTE =
  "It failed the same way three times: stop working on it. The judge sees it; do not edit for it again.";

/** A traceback frame in a check's own inline script (`python -c` / `python -`). */
const CHECK_SCRIPT_FRAME = /File "<(string|stdin)>", line (\d+)/g;
/** The raised class on a traceback's last line, not a `raise X(` source line. */
const RAISED_CLASS = /\b([A-Z][\w.]*(?:Error|Exception|Exit|Interrupt))\b(?!\s*\()/g;

/**
 * A failure's identity across runs. When the check is an inline script
 * that raised, it is the script's own line(s) plus the raised class: the
 * message and the code under test's line numbers change with every edit
 * while the same assert keeps failing. Measured (k8ak, 16-11-2026): one
 * wrong assert failed 5 runs in a row and never reached doubt, because
 * each run's message differed. Otherwise the detail without the run's
 * timing and the throwaway copy's directories, which differ every run.
 */
export function checkFailureSignature(detail: string): string {
  const frames = [...detail.matchAll(CHECK_SCRIPT_FRAME)].map((m) => m[2]);
  if (frames.length > 0) {
    const raised = [...detail.matchAll(RAISED_CLASS)].at(-1)?.[1];
    return `check-line:${frames.join(">")}${raised === undefined ? "" : ` ${raised}`}`;
  }
  return detail
    .replace(/\b\d+(?:\.\d+)? ?(?:ms|s)\b/g, "#")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s"'`\\/]+[\\/])+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CHECK_LINE_CHARS = 200;

/**
 * The source of the check's own line that raised — the outermost frame in
 * its inline script — so the worker sees which assert failed even when
 * `describeCheckSpec` clipped the script. `undefined` when the detail
 * names no such frame or the check carries no script to quote.
 */
export function failingCheckLine(
  check: Readonly<Record<string, unknown>>,
  detail: string,
): { line: number; source: string } | undefined {
  const frame = /File "<(string|stdin)>", line (\d+)/.exec(detail);
  if (frame === null) return undefined;
  const args = Array.isArray(check.args) ? check.args : [];
  const dashC = args.indexOf("-c");
  const script =
    frame[1] === "stdin"
      ? check.stdin
      : dashC >= 0
        ? args[dashC + 1]
        : undefined;
  if (typeof script !== "string") return undefined;
  const line = Number(frame[2]);
  const source = script.split(/\r?\n/)[line - 1]?.trim();
  if (source === undefined || source.length === 0) return undefined;
  return {
    line,
    source: source.length > CHECK_LINE_CHARS ? `${source.slice(0, CHECK_LINE_CHARS)}…` : source,
  };
}

/**
 * The steer carrying the runtime's run of a worker's own checks after a
 * change: the first failures with their output, or that all passed.
 * `outcomes` are index-aligned with `checks` (`runContractChecks`);
 * `repeats` holds the standing of a check whose failure came back
 * unchanged. Not called when every failing check is `silent`.
 */
export function formatCheckResultSteer(
  checks: readonly Readonly<Record<string, unknown>>[],
  outcomes: readonly { ok: boolean; detail: string }[],
  repeats: ReadonlyMap<number, CheckRepeatState> = new Map(),
): string {
  const total = outcomes.length;
  const failed = outcomes
    .map((outcome, i) => ({ outcome, check: checks[i] ?? {}, state: repeats.get(i) }))
    .filter(({ outcome }) => !outcome.ok);
  if (failed.length === 0) {
    return `The runtime ran your task's ${total} check${total === 1 ? "" : "s"} after your last change: all passed. Your task is done: reply now, naming the files you wrote.`;
  }
  const line = ({ outcome, check }: (typeof failed)[number]) => {
    const failing = failingCheckLine(check, outcome.detail);
    const quoted =
      failing === undefined ? "" : `\n  failing check line ${failing.line}: \`${failing.source}\``;
    return `- \`${describeCheckSpec(check)}\`: ${outcome.detail}${quoted}`;
  };
  const open = failed.filter(({ state }) => state === undefined || state === "doubt");
  const stopped = failed.filter(({ state }) => state === "stop");
  const silent = failed.length - open.length - stopped.length;
  const shown = open
    .slice(0, CHECK_STEER_MAX_FAILURES)
    .map((entry) => (entry.state === "doubt" ? `${line(entry)}\n  ${CHECK_DOUBT_NOTE}` : line(entry)));
  const more = open.length - shown.length;
  return [
    `The runtime ran your task's checks after your last change: ${failed.length} of ${total} failed.`,
    ...shown,
    ...(more > 0 ? [`- +${more} more failing`] : []),
    ...stopped.map((entry) => `${line(entry)}\n  ${CHECK_STOP_NOTE}`),
    ...(silent > 0 ? [`- +${silent} failing that you were told to stop working on — leave ${silent === 1 ? "it" : "them"}`] : []),
    open.length > 0
      ? `Fix the first failure with \`os.fs.edit\`; the runtime runs the checks again after your next change, so do not run them yourself.`
      : `Nothing else fails: reply now, naming each check you stopped on and what your task text says about it.`,
  ].join("\n");
}

/**
 * Measured (k8d, 16-11-2026): both local workers of a fan-out into an
 * empty folder spent their first step on `os.fs.list` of it, and the
 * core worker — the task that set the pace — listed it again in its
 * second: 36 s of a 401 s run, since every step pays the thinking cap.
 * The runtime lists the working directory's top level as the worker is
 * dispatched (a later wave sees its providers' files), and the brief
 * carries it so the first step can be real work.
 */
export const START_LISTING_LIMIT = 40;

export function renderStartListing(
  workingDir: string,
  entries: readonly string[] | undefined,
): string | undefined {
  if (entries === undefined) return undefined;
  if (entries.length === 0) {
    return `AT START: ${workingDir} is empty — there is nothing in it to list or read.`;
  }
  const shown = entries.slice(0, START_LISTING_LIMIT);
  const more = entries.length - shown.length;
  return `AT START: ${workingDir} holds (top level, a directory ends in /): ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}. Do not list it again; list only a directory below it you need.`;
}

export function renderWorkerBrief(
  task: DelegateTask,
  options: {
    workingDir: string;
    originalRequest?: string;
    contract?: DelegateContract;
    /** The working directory's top level at dispatch, `.git` left out; undefined renders nothing. */
    startEntries?: readonly string[];
    /** The runtime runs this task's own checks after each change (`CHECKS_RUN_BY_RUNTIME_RULE`). */
    checksRunAfterChange?: boolean;
  },
): string {
  const request = options.originalRequest?.trim() ?? "";
  const lines: string[] = [
    `You are a worker agent executing one delegated task inside ${options.workingDir}; you have no memory of the parent conversation.`,
    ``,
    ...(request.length > 0 ? [...quoteOriginalRequest(request), ``] : []),
    ...(options.contract ? [...quoteContract(options.contract, task.id), ``] : []),
    `TASK ${task.id}: ${task.title}`,
    ``,
    task.instructions,
  ];
  if (task.deliverable) {
    lines.push(``, `DELIVERABLE: ${task.deliverable}`);
  }
  if (task.files && task.files.length > 0) {
    lines.push(``, `FILES:`, ...task.files.map((f) => `- ${f}`));
  }
  const listing = renderStartListing(options.workingDir, options.startEntries);
  if (listing !== undefined) lines.push(``, listing);
  lines.push(
    ``,
    `RULES:`,
    `- Work autonomously. Never ask a question and never wait for confirmation — there is no user on this session. If something is ambiguous, take the most reasonable reading and say what you assumed in your reply.`,
    `- \`os.fs.write\` creates any missing parent directories itself, so \`mkdir\` is never needed before a write.`,
    `- The operator authorised this fan-out to write files AND run commands in the directories the task names, so working there needs no permission: write the files, run the build, run the tests, read the output. Anything outside them is refused, not queued: a tool result carrying "${FUSION_WORKER_APPROVAL_MARKER}" means nobody can approve it here. Stop retrying it and say in your reply exactly what was blocked and where, so the orchestrator can re-send the task with that path named — it cannot run the action for you. If the refusal also says "${FUSION_WORKER_OPERATOR_ONLY_MARKER}" (a dangerous command, the agent's own config or secret files, a mail, a password or a payment), re-sending will not help: do not try another way to do the same thing, just name the exact command or file in your reply as something only the user can run or approve.`,
    `- Read files only inside ${options.workingDir} and the directories this task writes in; a read anywhere else is refused. Do not search other projects for context — ${request.length > 0 ? "your task, its FILES and the original request are" : "your task and its FILES are"} the context you have.`,
    siblingFilesRule(options.contract !== undefined),
    EDIT_NOT_REWRITE_RULE,
    STDIN_SELF_TEST_RULE,
    RUN_BEFORE_REREAD_RULE,
    ...(options.checksRunAfterChange === true ? [CHECKS_RUN_BY_RUNTIME_RULE] : []),
    SLOW_PASS_RULE,
    NAMED_CASES_RULE,
    BROWSER_CODE_RULE,
    ...(request.length > 0 ? [EXACT_SPELLING_RULE] : []),
    `- Finish with \`reply\` carrying the concise result of this task (about ${WORKER_REPLY_CHAR_BUDGET} characters at most). That reply is the ONLY thing the orchestrator receives — findings, file paths, decisions and anything it needs to merge your part must be inside it.`,
    ...(options.contract
      ? [
          `- End the reply with a \`PROVIDED:\` list of what you produced, one line per item, using the CONTRACT's exact names (kind, name, path). Name anything you provide differently from the contract, or could not provide, on its own line.`,
        ]
      : []),
  );
  return lines.join("\n");
}
