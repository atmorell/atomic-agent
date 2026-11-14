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
 * The same prompt again means the caller threw the last answer away (a
 * parse retry). The session still holds that answer, so the step is asked
 * again in it instead of writing the whole conversation to the cache anew.
 */
export const DISCARDED_ANSWER_NOTE =
  "Your previous answer could not be used and was discarded; nothing in it was run. Answer this step again, in the required tool-call format only.";

/** What one answered call leaves behind for the next call to continue. */
export interface CliSessionLink {
  id: string;
  system: string;
  /** The whole conversation text as of that call, not just what was sent. */
  user: string;
  answer: string;
}

/** One call planned against the session: a new one, or the next link. */
export interface CliSessionTurn {
  id: string;
  resume: boolean;
  system: string;
  user: string;
  /** Text for stdin: `user`, or only what is new since the last call. */
  input: string;
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
): CliSessionTurn | null {
  const cut = prompt.indexOf(FIXED_PART_END);
  if (cut <= 0) return null;
  const system = `${baseSystemPrompt}\n\n${prompt.slice(0, cut).trimEnd()}`;
  const user = prompt.slice(cut).trimStart();
  if (previous && previous.system === system) {
    let shared = 0;
    const limit = Math.min(previous.user.length, user.length);
    while (shared < limit && previous.user[shared] === user[shared]) shared += 1;
    const movedTail = previous.user.slice(shared);
    const added = user.slice(shared);
    if (movedTail.length <= MAX_MOVED_TAIL_CHARS && added.endsWith(movedTail)) {
      const input =
        added.trim().length > 0
          ? withoutOwnAnswer(added, previous.answer)
          : DISCARDED_ANSWER_NOTE;
      return { id: previous.id, resume: true, system, user, input };
    }
  }
  return { id: newId(), resume: false, system, user, input: user };
}

/** The same call as the opening of a new session, after a failed resume. */
export function restartCliSessionTurn(
  turn: CliSessionTurn,
  newId: () => string,
): CliSessionTurn {
  return { ...turn, id: newId(), resume: false, input: turn.user };
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
