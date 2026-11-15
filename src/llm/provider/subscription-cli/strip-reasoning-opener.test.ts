import { describe, expect, it } from "vitest";

import { withoutReasoningOpener } from "./strip-reasoning-opener.js";

describe("withoutReasoningOpener", () => {
  it("drops the trailing opener and ends in one newline", () => {
    expect(withoutReasoningOpener("user: do it\n\n<think>\n")).toBe(
      "user: do it\n",
    );
    // The repair prompt's opener has no trailing newline.
    expect(withoutReasoningOpener("### respond\nRespond now.\n<think>")).toBe(
      "### respond\nRespond now.\n",
    );
  });

  it("drops the empty block a thinking-off profile ends with", () => {
    expect(withoutReasoningOpener("user: x\n<think>\n\n</think>\n\n")).toBe(
      "user: x\n",
    );
  });

  it("leaves every other prompt exactly as it is", () => {
    for (const prompt of [
      "user: x\n",
      "user: x\n### current-date\n2026-11-15\n",
      "<think>\nreasoning</think>\n",
      "summarise this",
    ]) {
      expect(withoutReasoningOpener(prompt)).toBe(prompt);
    }
  });
});
