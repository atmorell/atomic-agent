import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import type { WorkerPricing } from "./worker-result.js";

/**
 * Escalating a stuck worker to a stronger model (ATO-942, ATO-66).
 *
 * The advisor path: the escalation model reads a compressed trace of
 * the node (its brief, what it has done, why it looks stuck) and answers
 * with a short hint, which reaches the worker as a mid-turn steer; the
 * worker carries on. The replacement path (behind `escalationReplace`)
 * re-runs the task on the escalation model with what was found.
 *
 * Escalation only ever goes to `ResolvedRunMode.escalation`, a provider
 * the operator configured (the orchestrator leg by default), and every
 * call is priced before and after: a call whose worst case is over the
 * per-escalation cap is not made, and the row says what it cost.
 */

/** Room for a 400–700 token hint, and no more. */
export const ADVISOR_MAX_OUTPUT_TOKENS = 700;
/** How much of the brief the advisor reads; the rest is the trace. */
export const ADVISOR_BRIEF_CHARS = 3_000;
/** How much of a hint the log keeps: a 700-token hint fits. */
export const ADVISOR_HINT_LOG_CHARS = 4_000;

export type EscalationTrigger =
  | { kind: "stall"; detail: string }
  | { kind: "slow-pass"; detail: string }
  | { kind: "first-answer-cut"; detail: string }
  | { kind: "manual" };

export function describeTrigger(trigger: EscalationTrigger): string {
  if (trigger.kind === "manual") return "the person asked for it";
  if (trigger.kind === "stall") return `stalled: ${trigger.detail}`;
  if (trigger.kind === "slow-pass") return `passes but too slow: ${trigger.detail}`;
  return `first answer cut: ${trigger.detail}`;
}

/** One escalation completion, on a pinned provider, no fallback. */
export type EscalationComplete = (input: {
  providerId: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  /**
   * The session that delegated, so the call counts in its spend readout
   * (ATO-1388). Set by `fusion.delegate`, never by the callers below it.
   */
  sessionId?: string;
  /**
   * Continue a vendor CLI's session under this key (the provider's
   * `CompletionRequest.sessionId`): the fusion judge's retry round
   * resumes its first round and reads it from cache. Unrelated to
   * `sessionId`, which only names whose spend the call is.
   */
  cliSessionKey?: string;
}) => Promise<{ content: string; usage?: CompletionUsage }>;

/**
 * The advisor names the defect and the one edit that fixes it (k8h,
 * 16-11-2026): asked for "which file to write", it sent a worker that
 * had one wrong character in a regex into a 94-second rewrite of two
 * files, and the rewrite brought a new bug. `evidence` is the worker's
 * own failing run and reads (`WorkerRunCollector.evidence()` in
 * worker-result.ts).
 *
 * `checks` is the runtime's last run of the task's own checks when it
 * failed (`formatStandingCheckFailures`). k8an (16-11-2026): without it
 * the advisor saw only the worker's passing runs and answered "No defect
 * is visible in the evidence" while the check kept failing on an assert
 * in the worker's own test, 19 steps without a write.
 */
export function renderAdvisorPrompt(input: {
  brief: string;
  trigger: EscalationTrigger;
  findings: string;
  evidence?: string;
  checks?: string;
}): string {
  const brief =
    input.brief.length > ADVISOR_BRIEF_CHARS
      ? `${input.brief.slice(0, ADVISOR_BRIEF_CHARS)}\n[… brief truncated]`
      : input.brief;
  const evidence = input.evidence?.trim() ?? "";
  const checks = input.checks?.trim() ?? "";
  return [
    "You are advising a smaller model that is working on one task and appears to be stuck.",
    "Read its brief, what it has done and the evidence below. If the evidence shows the defect, name it as file:line and give the exact old and new lines for one os.fs.edit. Never tell it to rewrite or re-create a file. If you cannot see the defect, name the one command that would show it, such as a short script on stdin that imports the module and calls it. Then say what to stop doing. Under 300 words, no preamble.",
    // k8o: the worker's runs passed but slowly, and it hunted for a
    // defect it did not have; the fix was a different design.
    ...(input.trigger.kind === "slow-pass"
      ? [
          "Its runs pass but too slowly for the brief's limit: the defect is the design. Name the code that redoes work per item as file:line and the smallest change that meets the limit (such as recomputing only what a change affects), as os.fs.edit lines where they fit.",
        ]
      : []),
    "",
    "## Brief",
    brief,
    "",
    "## Why it looks stuck",
    describeTrigger(input.trigger),
    "",
    "## What it has done so far",
    input.findings,
    "",
    ...(checks.length > 0
      ? [
          "## The task's checks, run by the runtime: still failing",
          "These decide the task. Where they fail and its own runs pass, the defect is in what the failing check runs, which can be a test file the worker wrote itself.",
          checks,
          "",
        ]
      : []),
    "## Evidence: its own runs and reads",
    evidence.length > 0 ? evidence : "(none recorded: it has not run anything or re-read a file it wrote)",
  ].join("\n");
}

/**
 * A note the person typed for one worker (ATO-568). The worker's own
 * "user" is the orchestrator's brief, so the note says who it is from:
 * the person outranks the brief, and a worker that read it as the
 * orchestrator changing its mind would not know which to follow.
 */
export function formatPersonSteer(text: string): string {
  return `Note from the person running this session, sent to you while you work. It outranks your brief where the two disagree:\n\n${text.trim()}`;
}

/**
 * k8o (16-11-2026): the tests worker's run failed inside `ark/ark.py`,
 * which the core worker was still writing; the advisor it asked sent it
 * to edit that file. A failure in another task's file is that task's.
 */
export function formatForeignFailureSteer(path: string, owner: string): string {
  return `Your last failing run fails inside ${path}, which task "${owner}" writes and may still be writing. Do not edit it or work around it: finish your own files, check them against the contract's names, and reply; the orchestrator checks the parts together.`;
}

/** The steer the worker reads at its next step. */
export function formatAdvisorSteer(model: string, hint: string): string {
  return `Advice from a stronger model (${model}) after your recent steps looked stuck. Follow it unless your files show it is wrong:\n\n${hint.trim()}`;
}

/** Worst case of a call: the whole prompt uncached plus the full reply. */
export function worstCaseCostUsd(
  promptChars: number,
  maxOutputTokens: number,
  pricing: WorkerPricing,
): number {
  return (
    (promptChars / 4 / 1_000_000) * pricing.input +
    (maxOutputTokens / 1_000_000) * pricing.output
  );
}

export type AdviceOutcome =
  | { ok: true; hint: string; costUsd: number | null; usage?: CompletionUsage }
  | { ok: false; reason: string; costUsd: number | null };

/**
 * Ask the escalation model for a hint. Never throws: a refusal (cap,
 * empty answer, provider error) comes back as a reason for the row.
 */
export async function requestAdvice(input: {
  target: FusionEscalationTarget;
  pricing: WorkerPricing | undefined;
  prompt: string;
  complete: EscalationComplete;
  signal: AbortSignal;
}): Promise<AdviceOutcome> {
  const { target, pricing } = input;
  if (pricing !== undefined) {
    const worst = worstCaseCostUsd(
      input.prompt.length,
      ADVISOR_MAX_OUTPUT_TOKENS,
      pricing,
    );
    if (worst > target.maxUsd) {
      return {
        ok: false,
        reason: `its worst case (${formatCost(worst)}) is over the escalation cap (${formatCost(target.maxUsd)}, llm.runMode.fusion.escalationMaxUsd)`,
        costUsd: null,
      };
    }
  }
  try {
    const answer = await input.complete({
      providerId: target.providerId,
      prompt: input.prompt,
      maxOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      signal: input.signal,
    });
    const costUsd =
      pricing === undefined || answer.usage === undefined
        ? null
        : estimateUsageCostUsd(answer.usage, pricing);
    const hint = answer.content.trim();
    if (hint.length === 0) {
      return { ok: false, reason: "the escalation model sent no answer", costUsd };
    }
    return {
      ok: true,
      hint,
      costUsd,
      ...(answer.usage === undefined ? {} : { usage: answer.usage }),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `the escalation call failed: ${err instanceof Error ? err.message : String(err)}`,
      costUsd: null,
    };
  }
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown (no price for this model)";
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * The live workers of every running fan-out, so the person can act on
 * one (ATO-66 and the TUI's stop / escalate actions). Keyed by the
 * parent session and the task id; an entry lives exactly as long as its
 * worker turn.
 */
export interface LiveWorkerControls {
  stop(): void;
  /** Resolves with what happened, in one line for the feed. */
  escalate(): Promise<string>;
  /**
   * Queue the person's note for this worker alone (ATO-568). It reaches
   * the worker at its next step boundary, the same point the session's
   * own steers land. `false` when the worker's turn is no longer taking
   * steers, the text is blank or its inbox is full: nothing was queued.
   */
  steer(text: string): boolean;
}

export class FusionLiveWorkers {
  private readonly workers = new Map<string, LiveWorkerControls>();

  private key(parentSessionId: string, taskId: string): string {
    return `${parentSessionId}\u0000${taskId}`;
  }

  register(
    parentSessionId: string,
    taskId: string,
    controls: LiveWorkerControls,
  ): () => void {
    const key = this.key(parentSessionId, taskId);
    this.workers.set(key, controls);
    return () => {
      if (this.workers.get(key) === controls) this.workers.delete(key);
    };
  }

  /** `false` when no such worker is running. */
  stop(parentSessionId: string, taskId: string): boolean {
    const worker = this.workers.get(this.key(parentSessionId, taskId));
    if (worker === undefined) return false;
    worker.stop();
    return true;
  }

  /** `null` when no such worker is running. */
  async escalate(
    parentSessionId: string,
    taskId: string,
  ): Promise<string | null> {
    const worker = this.workers.get(this.key(parentSessionId, taskId));
    if (worker === undefined) return null;
    return worker.escalate();
  }

  /**
   * `false` when no such worker is running, or when it is running but
   * did not take the note (see {@link LiveWorkerControls.steer}). Only
   * the fan-out's own parent session reaches its workers: the key is
   * the pair, never the task id alone.
   */
  steer(parentSessionId: string, taskId: string, text: string): boolean {
    if (text.trim().length === 0) return false;
    const worker = this.workers.get(this.key(parentSessionId, taskId));
    if (worker === undefined) return false;
    return worker.steer(text);
  }

  /** True while `taskId` of `parentSessionId`'s fan-out is running. */
  isRunning(parentSessionId: string, taskId: string): boolean {
    return this.workers.has(this.key(parentSessionId, taskId));
  }

  running(parentSessionId: string): string[] {
    const prefix = `${parentSessionId}\u0000`;
    return [...this.workers.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}
