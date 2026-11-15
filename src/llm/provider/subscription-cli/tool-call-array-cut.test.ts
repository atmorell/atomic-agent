import { describe, expect, it } from "vitest";

import { ToolCallArrayCut } from "./tool-call-array-cut.js";

const ARRAY = '[{"tool":"fs.read","args":{"path":"a]b\\"[.txt"}}]';
const TAIL = '\n\nuser[fusion.delegate] {"ok":true}\nassistant: done';

/** Feed `deltas` until a cut; what the stream would have passed on. */
function run(deltas: readonly string[]) {
  const cut = new ToolCallArrayCut();
  const passed: string[] = [];
  for (const delta of deltas) {
    const kept = cut.push(delta);
    if (kept !== null) {
      if (kept) passed.push(kept);
      return { cut: true, passed, answer: cut.answer, received: cut.received };
    }
    passed.push(delta);
  }
  return { cut: false, passed, answer: cut.answer, received: cut.received };
}

/** `text` split into chunks of `size` characters. */
function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("ToolCallArrayCut", () => {
  it("stops at the array's closing bracket once more text follows", () => {
    const result = run([ARRAY + TAIL]);
    expect(result.cut).toBe(true);
    expect(result.passed.join("")).toBe(ARRAY);
    expect(result.answer).toBe(ARRAY);
    expect(result.received).toBe(ARRAY.length + TAIL.length);
  });

  it("finds the same end however the stream is split, brackets in strings included", () => {
    for (const size of [1, 2, 3, 7, 16]) {
      const result = run(chunks(`  ${ARRAY}${TAIL}`, size));
      expect(result.cut).toBe(true);
      // Whitespace after the array may already have streamed.
      expect(result.passed.join("").trimEnd()).toBe(`  ${ARRAY}`);
      expect(result.answer).toBe(`  ${ARRAY}`);
    }
  });

  it("keeps trailing whitespace undecided and cuts on the next real character", () => {
    const result = run([ARRAY, "\n\n", "user: next"]);
    expect(result.cut).toBe(true);
    // The whitespace was already passed on; nothing of the next delta is.
    expect(result.passed).toEqual([ARRAY, "\n\n"]);
    expect(result.answer).toBe(ARRAY);
  });

  it("never cuts an answer that is only the array", () => {
    expect(run([ARRAY, "\n"]).cut).toBe(false);
  });

  it("never cuts prose, a fence, or an array that is not tool calls", () => {
    for (const answer of [
      `Reading first.\n${ARRAY}${TAIL}`,
      `\`\`\`json\n${ARRAY}\n\`\`\`${TAIL}`,
      `[1, 2]${TAIL}`,
      `[]${TAIL}`,
      `[{"name":"fs.read"}]${TAIL}`,
      `[{"tool":""}]${TAIL}`,
      `[{"tool":"fs.read",}]${TAIL}`,
    ]) {
      const result = run(chunks(answer, 5));
      expect(result.cut, answer).toBe(false);
      expect(result.passed.join("")).toBe(answer);
    }
  });

  it("passes everything through once it has decided not to cut", () => {
    const cut = new ToolCallArrayCut();
    expect(cut.push("text")).toBeNull();
    expect(cut.push(`${ARRAY}${TAIL}`)).toBeNull();
  });
});
