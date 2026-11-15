import { parseToolCalls } from "../../grammar/tool-call-grammar.js";

/**
 * A vendor CLI caches a prompt only up to where a call ended, and a
 * prompt sent whole as one user text never ends where the last one did
 * (the answer and its results now sit in the middle of it). Continuing
 * the CLI's own session instead makes every earlier call a cached read:
 * the first call names a session, later calls resume it and send only
 * what the conversation gained since.
 *
 * The cloud prompt up to this heading (persona, rules, skills, tools) is
 * the same text in every session, so it goes into the system prompt,
 * where it is also read from cache by the first call of the next
 * session. `### capabilities` is the first section that carries the
 * session's own working directory.
 */
const FIXED_PART_END = "\n### capabilities";

/**
 * The prompt ends in a short step-mutable tail (the reasoning opener)
 * that moves with every call. A longer difference is not a moved tail
 * but a rewritten prompt, and that starts a new session.
 */
const MAX_MOVED_TAIL_CHARS = 400;

/**
 * Sent instead of an identical prompt under `resumeAcrossRepair`: the
 * session already holds that prompt and the turned-down answer.
 */
export const REPEAT_NOTICE =
  "### tool-call-repair\n" +
  "The previous answer was rejected before any tool ran. Answer the same " +
  "request again: one JSON tool-call array, and nothing after it.\n";

/** What one answered call leaves behind for the next call to continue. */
export interface CliSessionLink {
  id: string;
  system: string;
  /** The whole conversation text as of that call, not just what was sent. */
  user: string;
  answer: string;
  /**
   * Set on a side call (`resumeAcrossRepair`): the link it continued
   * from. The side text — a repair notice after the conversation — is
   * not part of the conversation, so the next call continues from here.
   */
  before?: CliSessionLink;
}

/** One call planned against the session: a new one, or the next link. */
export interface CliSessionTurn {
  id: string;
  resume: boolean;
  system: string;
  user: string;
  /** Text for stdin: `user`, or only what is new since the last call. */
  input: string;
  /** This call is a side call; its link keeps the one it continued. */
  before?: CliSessionLink;
}

export interface CliSessionOptions {
  /**
   * Keep a parse repair inside the session (`subscriptionCli.
   * resumeAcrossRepair`). The repair prompt is the rejected prompt plus a
   * `### tool-call-repair` section, with the reasoning opener moved past
   * it and its trailing newline gone; the next step's prompt drops that
   * section again. Without this, both calls open a new session and the
   * whole conversation is written to the cache once more.
   */
  resumeAcrossRepair?: boolean;
}

/**
 * Plan a call. `null` when the prompt has no fixed part to split off (a
 * side call, another prompt layout) — such a call stays stateless.
 */
export function planCliSessionTurn(
  baseSystemPrompt: string,
  prompt: string,
  previous: CliSessionLink | undefined,
  newId: () => string,
  options: CliSessionOptions = {},
): CliSessionTurn | null {
  const cut = prompt.indexOf(FIXED_PART_END);
  if (cut <= 0) return null;
  const system = `${baseSystemPrompt}\n\n${prompt.slice(0, cut).trimEnd()}`;
  const user = prompt.slice(cut).trimStart();
  const lenient = options.resumeAcrossRepair === true;
  if (previous && previous.system === system) {
    if (lenient && previous.user === user) {
      // An identical re-send means the last answer was turned down (a
      // parse retry whose notice did not survive a linked prompt rebuild).
      return { id: previous.id, resume: true, system, user, input: REPEAT_NOTICE };
    }
    const next = continueLink(previous.user, user, lenient);
    if (next) {
      const input = withoutOwnAnswer(next.added, previous.answer);
      return {
        id: previous.id,
        resume: true,
        system,
        user,
        input,
        ...(lenient && next.side ? { before: previous } : {}),
      };
    }
    // The call after a repair: the conversation goes on from the call the
    // repair answered for, and the session already holds both answers.
    const before = lenient ? previous.before : undefined;
    const back = before ? continueLink(before.user, user, true) : null;
    if (back && !back.side) {
      const input = withoutOwnAnswer(back.added, previous.answer);
      return { id: previous.id, resume: true, system, user, input };
    }
  }
  // Also the path for an identical re-send: a session cannot be resumed
  // from before its last answer.
  return { id: newId(), resume: false, system, user, input: user };
}

/**
 * What `user` adds to the conversation text `previousUser`, when it only
 * extends it (the step-mutable tail may move to the new end). `side`: the
 * new text is a section after the conversation rather than more of it.
 */
function continueLink(
  previousUser: string,
  user: string,
  lenient: boolean,
): { added: string; side: boolean } | null {
  let shared = 0;
  const limit = Math.min(previousUser.length, user.length);
  while (shared < limit && previousUser[shared] === user[shared]) shared += 1;
  const movedTail = previousUser.slice(shared);
  const added = user.slice(shared);
  if (movedTail.length > MAX_MOVED_TAIL_CHARS || added.trim().length === 0) {
    return null;
  }
  if (added.endsWith(movedTail)) {
    const fresh = added.slice(0, added.length - movedTail.length);
    return { added, side: isSideText(fresh) };
  }
  // A repair re-appends the opener without its trailing newline.
  const tail = movedTail.trimEnd();
  const body = added.trimEnd();
  if (lenient && body.endsWith(tail)) {
    const fresh = body.slice(0, body.length - tail.length);
    return { added, side: isSideText(fresh) };
  }
  return null;
}

/** Conversation lines are `role: …`; a side call adds a `### ` section. */
function isSideText(fresh: string): boolean {
  return fresh.trimStart().startsWith("### ");
}

/** The same call as the opening of a new session, after a failed resume. */
export function restartCliSessionTurn(
  turn: CliSessionTurn,
  newId: () => string,
): CliSessionTurn {
  return {
    id: newId(),
    resume: false,
    system: turn.system,
    user: turn.user,
    input: turn.user,
  };
}

/**
 * The conversation lists the model's last tool calls again as
 * `assistant_tool_call: <tool> <args>` lines (`renderCloudTurn`). In a
 * resumed session that answer already stands as the assistant turn, so
 * its copies are dropped instead of being written to the cache a second
 * time. Only a byte-exact line is dropped; anything else stays.
 */
export function withoutOwnAnswer(added: string, answer: string): string {
  let calls;
  try {
    calls = parseToolCalls(answer, {}, { repairJson: true }).calls;
  } catch {
    return added;
  }
  let out = added;
  for (const call of calls) {
    const line = `assistant_tool_call: ${call.tool} ${JSON.stringify(call.args)}\n`;
    const at = out.startsWith(line) ? 0 : out.indexOf(`\n${line}`) + 1;
    if (at > 0 || out.startsWith(line)) {
      out = out.slice(0, at) + out.slice(at + line.length);
    }
  }
  return out.trim().length > 0 ? out : added;
}
