import { describe, it, expect } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import { parseToolCalls } from "../../llm/grammar/tool-call-grammar.js";
import { QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import { getReasoningTagOptions, normalizeContent } from "./step-reasoning.js";

const completion = (content: string): CompletionResult =>
  ({ content }) as unknown as CompletionResult;

describe("normalizeContent", () => {
  it("re-opens the think block for a completion that continues it", () => {
    expect(
      normalizeContent(completion("plan</think>[]"), QWEN_THINK_PROFILE, true),
    ).toBe("<think>plan</think>[]");
  });

  it("adds nothing when the completion does not assume open reasoning", () => {
    expect(
      normalizeContent(completion("plan</think>[]"), QWEN_THINK_PROFILE, false),
    ).toBe("plan</think>[]");
  });

  it("keeps the call of an answer that opens with it and ends in a stray close tag", () => {
    // Trace s-6fe0e191, step 1: a valid call, then an invented result.
    const raw =
      '[{"tool":"verify.run","args":{"cmd":"pytest"}}]\n\n### world\n' +
      'tool_result verify.run: {\n  "checks_passed": "2/2"\n</think>';
    const text = normalizeContent(completion(raw), QWEN_THINK_PROFILE, true);
    expect(text).toBe(raw);
    const batch = parseToolCalls(text, getReasoningTagOptions(QWEN_THINK_PROFILE));
    expect(batch.calls.map((call) => call.tool)).toEqual(["verify.run"]);
  });
});
