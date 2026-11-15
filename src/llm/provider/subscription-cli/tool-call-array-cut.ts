/**
 * Watches a streamed answer for the point where it should have ended: a
 * complete tool-call array at its start, followed by more text. A model
 * driven through a vendor CLI reads the prompt's conversation as a
 * transcript and sometimes keeps writing it after its array — an invented
 * tool result, the next user turn — and every such token is paid for at
 * the output price and again when the next call writes it to the cache.
 * The parser already ignores that text; this lets the provider stop the
 * CLI instead (`subscriptionCli.cutAfterToolCalls`).
 *
 * Deliberately narrow: the answer has to open (after whitespace) with
 * `[`, the array has to be strict JSON — a non-empty list of objects that
 * each name a `tool` — and the cut only comes once a non-whitespace
 * character follows it. Anything else (prose first, a fence, a broken
 * array) is never cut, so the parser and its repair see the whole answer.
 */
export class ToolCallArrayCut {
  private text = "";
  private start = -1;
  private end = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private done = false;

  /** The answer up to the array's closing bracket, once cut. */
  get answer(): string {
    return this.end < 0 ? this.text : this.text.slice(0, this.end);
  }

  /** Characters received so far, the cut-off text included. */
  get received(): number {
    return this.text.length;
  }

  /**
   * Feed the next delta. `null`: pass it on whole and keep reading.
   * Otherwise the part of it that still belongs to the answer; stop there.
   */
  push(delta: string): string | null {
    if (this.done) return null;
    const offset = this.text.length;
    this.text += delta;
    for (let i = offset; i < this.text.length; i += 1) {
      const ch = this.text[i]!;
      if (this.end >= 0) {
        if (isSpace(ch)) continue;
        this.done = true;
        return delta.slice(0, Math.max(0, this.end - offset));
      }
      if (this.start < 0) {
        if (isSpace(ch)) continue;
        if (ch !== "[") return this.stop();
        this.start = i;
        this.depth = 1;
        continue;
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === "[" || ch === "{") this.depth += 1;
      else if (ch === "]" || ch === "}") {
        this.depth -= 1;
        if (this.depth === 0) {
          if (!isToolCallArray(this.text.slice(this.start, i + 1))) {
            return this.stop();
          }
          this.end = i + 1;
        }
      }
    }
    return null;
  }

  private stop(): null {
    this.done = true;
    return null;
  }
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function isToolCallArray(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        !Array.isArray(call) &&
        typeof (call as { tool?: unknown }).tool === "string" &&
        (call as { tool: string }).tool.length > 0,
    )
  );
}
