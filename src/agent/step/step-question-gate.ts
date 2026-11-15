import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import {
  formatQuestionAnswerNotice,
  looksLikeQuestion,
} from "../policies/question-escalation.js";

/** How much of the answer or refusal the event carries. */
const DETAIL_CHARS = 500;

/**
 * The question text when this step's batch is one to hold, else `null`.
 * Synchronous so a step with nothing to hold does not yield between
 * parse and admission (the reasoning/admission seam).
 */
export function questionToHold(
  ctx: StepContext,
  deps: StepDependencies,
  batch: ToolCallBatch,
  policy: StepBatchPolicy,
): string | null {
  const gate = deps.questionGate;
  if (gate === undefined || ctx.terminalOnly === true) return null;
  if (policy.progressNote !== null || batch.calls.length !== 1) return null;
  const call = batch.calls[0]!;
  if (call.tool !== "reply") return null;
  const text = typeof call.args?.text === "string" ? call.args.text : "";
  if (!looksLikeQuestion(text) || gate.remaining() <= 0) return null;
  return text;
}

/**
 * Kodevagten at the step (`policies/question-escalation.ts`): a sole
 * `reply` that asks the person something, in a turn with a question
 * gate, is sent to the question model before it is dispatched. Answered,
 * the reply becomes the step's progress note (kept, flagged interim, the
 * turn goes on) and the answer is the next step's notice; the returned
 * batch then runs nothing. Otherwise the batch is returned as it was and
 * the reply closes the turn. The forced final step is never held. Call
 * it only with the text `questionToHold` returned.
 */
export async function holdQuestionForEscalation(
  ctx: StepContext,
  deps: StepDependencies,
  batch: ToolCallBatch,
  policy: StepBatchPolicy,
  text: string,
): Promise<ToolCallBatch> {
  const gate = deps.questionGate!;
  const call = batch.calls[0]!;

  const outcome = await gate.consult({
    question: text,
    request: ctx.originalRequest ?? ctx.userMessage ?? null,
    turns: ctx.session.turns,
    signal: ctx.signal,
    sessionId: ctx.session.id,
  });
  const detail =
    outcome.kind === "answered" ? outcome.answer : outcome.reason;
  deps.onEvent?.({
    type: "question_escalated",
    stepIndex: ctx.stepIndex,
    outcome: outcome.kind,
    providerId: outcome.kind === "failed" ? null : outcome.providerId,
    model: outcome.kind === "failed" ? null : outcome.model,
    costUsd: outcome.kind === "failed" ? null : outcome.costUsd,
    questionChars: text.length,
    detail:
      detail.length > DETAIL_CHARS ? `${detail.slice(0, DETAIL_CHARS)}…` : detail,
  });
  deps.logger?.info("question escalated", {
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    outcome: outcome.kind,
  });
  if (outcome.kind !== "answered") return batch;

  policy.setProgressNote(call);
  // The progress-note notice explains a reply batched with work; this
  // note was a sole reply, and the answer's notice says why it was kept.
  deps.progressNotes?.markNoticed();
  policy.appendTrimNotice(
    formatQuestionAnswerNotice(outcome.model, outcome.answer),
  );
  return { ...batch, calls: [] };
}
