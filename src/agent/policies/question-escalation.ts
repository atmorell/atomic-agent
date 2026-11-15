import type { ConversationTurn } from "../../session/conversation-turn.js";

/**
 * Kodevagten: the orchestrator's question goes to a stronger model before
 * it reaches the person.
 *
 * In a fusion orchestrator turn, a sole `reply` that ends on a question
 * would close the turn and wait for the person. With
 * `llm.runMode.fusion.questionProvider` set, the step first sends the
 * question, the request and the turn's recent work to that model. It
 * answers (`ANSWER:`) and the reply is kept as an interim note, the answer
 * reaches the orchestrator as a notice and the turn goes on; or it says it
 * cannot (`CANNOT:`) and the reply closes the turn as before, so the
 * person gets the question. A preference only the person holds, a secret,
 * and an approval for something that cannot be undone or leaves the
 * machine are always `CANNOT`.
 *
 * At most `maxPerTurn` questions per turn; the forced final step is never
 * held (it exists so a turn always ends with something for the person).
 */

/** Room for a short decision and its reason, and no more. */
export const QUESTION_MAX_OUTPUT_TOKENS = 900;
/** How much of the request and of the recent work the consult reads. */
export const QUESTION_REQUEST_CHARS = 4_000;
export const QUESTION_WORK_CHARS = 8_000;
/** Where in the reply a `?` makes it a question: its last characters. */
const QUESTION_TAIL_CHARS = 400;

/** One consult call; the runtime pins it to the question provider. */
export type QuestionConsult = (input: {
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  sessionId: string;
}) => Promise<{
  content: string;
  providerId: string;
  model: string | null;
  costUsd: number | null;
}>;

export type QuestionOutcome =
  | {
      kind: "answered";
      answer: string;
      providerId: string;
      model: string | null;
      costUsd: number | null;
    }
  | {
      kind: "cannot";
      reason: string;
      providerId: string;
      model: string | null;
      costUsd: number | null;
    }
  | { kind: "failed"; reason: string };

/** The per-turn gate the step asks; created by the loop for each fusion turn. */
export interface QuestionGate {
  /** Questions still allowed this turn. */
  remaining(): number;
  consult(input: {
    question: string;
    request: string | null;
    turns: readonly ConversationTurn[];
    signal: AbortSignal;
    sessionId: string;
  }): Promise<QuestionOutcome>;
}

export function createQuestionGate(
  consult: QuestionConsult,
  maxPerTurn: number,
): QuestionGate {
  let used = 0;
  return {
    remaining: () => Math.max(0, maxPerTurn - used),
    async consult(input) {
      used += 1;
      const prompt = renderQuestionPrompt({
        question: input.question,
        request: input.request,
        work: renderRecentWork(input.turns),
      });
      try {
        const answer = await consult({
          prompt,
          maxOutputTokens: QUESTION_MAX_OUTPUT_TOKENS,
          signal: input.signal,
          sessionId: input.sessionId,
        });
        const parsed = parseQuestionAnswer(answer.content);
        const where = {
          providerId: answer.providerId,
          model: answer.model,
          costUsd: answer.costUsd,
        };
        return parsed.kind === "answered"
          ? { kind: "answered", answer: parsed.text, ...where }
          : { kind: "cannot", reason: parsed.text, ...where };
      } catch (err) {
        if (input.signal.aborted) throw err;
        return {
          kind: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * A reply that asks the person something: a `?` in its last lines,
 * outside code and links. A report that merely quotes a question
 * earlier on is not one.
 */
export function looksLikeQuestion(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .trimEnd();
  return prose.slice(-QUESTION_TAIL_CHARS).includes("?");
}

export function renderQuestionPrompt(input: {
  question: string;
  request: string | null;
  work: string;
}): string {
  const request =
    input.request === null || input.request.trim().length === 0
      ? "(not recorded)"
      : clip(input.request, QUESTION_REQUEST_CHARS);
  return [
    "You stand in for the person who gave an AI coding orchestrator a task. The orchestrator is about to stop and ask the person the question below. Decide it yourself when you can, so the work goes on without them.",
    "",
    "Answer it yourself when the request, the work so far and sound engineering judgement settle it: which approach to take, whether to go on with the next step, whether to fix what it found, how to test it. Prefer the choice that finishes the task the person asked for, with proof.",
    "",
    "Do NOT answer, and say you cannot, when the answer needs: a preference or fact only the person holds; a password, key or other secret; or approval to do something that cannot be undone or leaves this machine (deleting data, publishing, deploying, sending messages, spending money, touching another machine).",
    "",
    "Reply in exactly one of these forms, nothing before it:",
    "ANSWER: <the decision and, in a sentence or two, why — written to the orchestrator>",
    "CANNOT: <one sentence: what only the person can decide>",
    "",
    "## The person's request",
    request,
    "",
    "## The work so far this turn",
    input.work.length === 0 ? "(nothing recorded)" : input.work,
    "",
    "## The orchestrator's question",
    input.question.trim(),
  ].join("\n");
}

/** `ANSWER:` → answered; `CANNOT:`, empty or anything unclear → cannot. */
export function parseQuestionAnswer(
  content: string,
): { kind: "answered" | "cannot"; text: string } {
  const trimmed = content.trim();
  const answer = /^\**\s*ANSWER\s*:\**\s*([\s\S]+)$/i.exec(trimmed);
  if (answer !== null && answer[1]!.trim().length > 0) {
    return { kind: "answered", text: answer[1]!.trim() };
  }
  const cannot = /^\**\s*CANNOT\s*:\**\s*([\s\S]*)$/i.exec(trimmed);
  if (cannot !== null) {
    return {
      kind: "cannot",
      text: cannot[1]!.trim() || "the question needs the person",
    };
  }
  return {
    kind: "cannot",
    text:
      trimmed.length === 0
        ? "the question model sent no answer"
        : "the question model's answer was not in the ANSWER/CANNOT form",
  };
}

/** The notice the orchestrator reads at its next step. */
export function formatQuestionAnswerNotice(
  model: string | null,
  answer: string,
): string {
  return [
    `Your question was not sent to the person. A stronger model (${model ?? "the question model"}) answered it on their behalf:`,
    "",
    answer.trim(),
    "",
    "Carry on with the task on that basis. Ask the person only what this answer does not settle.",
  ].join("\n");
}

/** The turn's work since the request, newest last, clipped from the front. */
export function renderRecentWork(turns: readonly ConversationTurn[]): string {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.kind === "user" && turn.steered !== true) {
      start = i + 1;
      break;
    }
  }
  const lines: string[] = [];
  for (const turn of turns.slice(start)) {
    if (turn.kind === "assistant_tool_call") {
      lines.push(`- call ${turn.tool} ${clip(JSON.stringify(turn.args), 300)}`);
    } else if (turn.kind === "tool_result") {
      lines.push(`  -> ${turn.status}: ${clip(turn.summary, 600)}`);
    } else if (turn.kind === "assistant_reply") {
      lines.push(`- note: ${clip(turn.text, 600)}`);
    } else if (turn.kind === "user") {
      lines.push(`- person (mid-turn): ${clip(turn.text, 600)}`);
    }
  }
  const text = lines.join("\n");
  return text.length > QUESTION_WORK_CHARS
    ? `[… earlier work cut]\n${text.slice(-QUESTION_WORK_CHARS)}`
    : text;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
