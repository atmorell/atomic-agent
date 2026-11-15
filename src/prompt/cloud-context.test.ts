import { describe, expect, it, vi } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState } from "../session/session-state.js";
import { userTurn, assistantToolCallTurn, toolResultTurn, assistantReplyTurn } from "../session/conversation-turn.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { buildNativeMessages } from "../llm/provider/openai/openai-native-messages.js";
import { compactionBoundaryHash } from "../session/session-compaction.js";
import { planCompaction } from "./plan-compaction.js";
import { getConfig } from "../config/index.js";
import { readContextLengthFromRejection } from "../llm/reliability/request-size-rejection.js";
import { isNativeShapeRejection } from "../llm/provider/openai/openai-native-messages.js";
import { PROFILE_SECTION_CAPTION } from "../memory/profile-renderer.js";
import type { MemoryEntry, MemoryIndexEntry } from "../memory/memory-store.js";

const mode = { mode: "cloud" as const, source: "provider" as const, providerId: "remote", modelId: "large" };
function fixture(): BuildPromptInput {
  const session = createEmptySessionState({ id: "cloud", workingDir: "/fixture" });
  session.turns = [userTurn("inspect", 1)];
  return { session, toolDescriptors: [], skillCatalog: [],
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    modelMode: mode, contextWindow: 200000, profileWindowApplies: false,
    toolTransport: "native_tools", suppressReasoningPrefill: true,
    tokenBudget: 1, conversationMaxTokens: 1, conversationMaxPairs: 1, sessionSectionsMaxTokens: 1,
    worldSnapshotMaxTokens: 1, loadedToolsMaxTokens: 1, recallMaxTokens: 1, profileMaxTokens: 1 };
}
const native = (prompt: ReturnType<typeof buildPrompt>) => buildNativeMessages(prompt.messages, { nameEscape: name => name });

describe("cloud message retention", () => {
  it("keeps full skills, results and state; appends updates after exactly the previous native history", () => {
    const input = fixture();
    const skill = "rules\n".repeat(3000) + "SKILL END";
    const result = "evidence\n".repeat(10000) + "RESULT END";
    input.session.loadedSkills = [{ name: "long", version: "1", body: skill, loadedAt: 1 }];
    input.session.worldSnapshot = { kind: "browser", digest: "v1", text: "ARIA\n".repeat(5000), capturedAt: 1 };
    input.session.turns.push(assistantToolCallTurn({ tool: "os.shell.run", args: {}, at: 2 }), toolResultTurn({ tool: "os.shell.run", status: "ok", summary: result, at: 3 }));
    const first = buildPrompt(input);
    expect(first.text).toContain(skill);
    expect(first.text).toContain(result);
    expect(first.text).toContain(input.session.worldSnapshot.text);
    expect(first.truncated).toBe(false);
    expect(input.session.cloudContext).toBeUndefined(); // pure preview
    input.session.cloudContext = first.cloudContext;
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("continue", 5));
    input.session.worldSnapshot = { ...input.session.worldSnapshot, digest: "v2", text: "new snapshot" };
    const second = buildPrompt(input);
    expect(native(second).slice(0, native(first).length)).toEqual(native(first));
    expect(second.text).toContain(result);
    expect(second.text.split(skill)).toHaveLength(2);
    expect(second.text).toContain("supersedes");
    input.session.cloudContext = second.cloudContext;
    expect(buildPrompt(input).cloudContext).toBe(second.cloudContext); // retry/unchanged state
    const restored = buildPrompt({ ...input, session: JSON.parse(JSON.stringify(input.session)) });
    expect(restored.text).toBe(second.text);
    expect(native(restored)).toEqual(native(second));
    const local = buildPrompt({ ...input, modelMode: { ...mode, mode: "local" } });
    expect(local.truncation.loadedSkills).toBe(true);
    expect(input.session.cloudContext).toBe(second.cloudContext);
    expect(buildPrompt(input).text).toBe(second.text);
  });

  it("does not duplicate a full skill.view result and retains it after a checkpoint", () => {
    const input = fixture();
    const body = "full instructions\n".repeat(2000) + "LAST RULE";
    input.session.loadedSkills = [{ name: "skill", version: "1", body, loadedAt: 1 }];
    input.session.turns.push(assistantToolCallTurn({ tool: "skill.view", args: { name: "skill" }, at: 2 }),
      toolResultTurn({ tool: "skill.view", status: "ok", summary: `# skill: skill (v1)\n${body}`, at: 3 }));
    const first = buildPrompt(input);
    expect(first.text.split(body)).toHaveLength(2);
    input.session.cloudContext = first.cloudContext;
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("continue", 5));
    input.session.compaction = { version: 1, summary: "Earlier work", coveredThrough: 4,
      boundaryHash: compactionBoundaryHash(input.session.turns[3]!), createdAt: 1, reason: "manual", model: null, tokensBefore: 10000, tokensAfter: 10 };
    const next = buildPrompt(input);
    expect(next.text).toContain(body);
    expect(next.text.split(body)).toHaveLength(2);
    expect(JSON.stringify(native(next))).not.toContain("no result recorded");
  });

  it("uses durable call ids across compaction and preserves grouped imported calls", () => {
    const input = fixture();
    input.session.turns.push(assistantReplyTurn("earlier", 2), userTurn("task", 3),
      assistantToolCallTurn({ tool: "a", args: {}, at: 4 }), assistantToolCallTurn({ tool: "b", args: {}, at: 5 }),
      toolResultTurn({ tool: "a", status: "ok", summary: "a result", at: 6 }), toolResultTurn({ tool: "b", status: "ok", summary: "b result", at: 7 }));
    const first = buildPrompt(input);
    input.session.cloudContext = first.cloudContext;
    input.session.compaction = { version: 1, summary: "Earlier work", coveredThrough: 2,
      boundaryHash: compactionBoundaryHash(input.session.turns[1]!), createdAt: 1, reason: "manual", model: null, tokensBefore: 100, tokensAfter: 10 };
    const next = native(buildPrompt(input));
    const calls = next.find(message => Array.isArray(message.tool_calls))?.tool_calls;
    expect(calls).toMatchObject([{ id: "call_turn_3" }, { id: "call_turn_4" }]);
    expect(JSON.stringify(next)).not.toContain("no result recorded");
  });

  it("does not compact because of the old pair or section caps", () => {
    const input = fixture();
    for (let i = 0; i < 10; i++) input.session.turns.push(assistantReplyTurn("done"), userTurn("more"));
    const prompt = buildPrompt(input);
    expect(prompt.droppedTurns).toBe(0);
    expect(planCompaction(input.session, prompt, getConfig().agent.compaction)).toBeNull();
  });

  it("checks schemas and final output overrides before sending, and marks the last cloud history message", () => {
    const input = fixture();
    const prompt = buildPrompt(input);
    const request = { prompt: prompt.text, messages: prompt.messages, modelMode: mode,
      contextBudget: { window: 16000, replyReserve: 1000 },
      tools: [{ type: "function", function: { name: "tool", parameters: { type: "object", properties: {} } } }] };
    const body = buildOpenAiChatBody(request, "model", false, undefined, undefined, true, undefined, { anthropicCacheControl: true });
    const messages = body.messages as Array<{ content: unknown }>;
    expect(messages[messages.length - 1]?.content).toMatchObject([{ cache_control: { type: "ephemeral" } }]);
    expect(body).not.toHaveProperty("contextBudget");
    expect(() => buildOpenAiChatBody(request, "model", false, { max_tokens: 16000 })).toThrow(/No content was truncated/);
    expect(() => buildOpenAiChatBody({ ...request, tools: [{ description: "schema".repeat(30000) }] }, "model", false)).toThrow(/context window/);
    try {
      buildOpenAiChatBody(request, "model", false, { max_tokens: 16000 });
      expect.fail("expected a capacity rejection");
    } catch (error) {
      expect(readContextLengthFromRejection(error)).toBe(16000);
      expect(isNativeShapeRejection(error)).toBe(false);
    }
    expect(() => buildOpenAiChatBody({ ...request, modelMode: { ...mode, mode: "local" } }, "model", false, { max_tokens: 16000 })).not.toThrow();
  });

  it("captions profile facts so a key does not read as a skill or tool name (ATO-320)", () => {
    const input = fixture();
    input.profileFacts = [{ id: 1, key: "hobby_builder", value: "true", validFrom: 1, updatedAt: 1, pinned: true,
      keywords: [], supersedes: null, supersededBy: null, voteScore: 0 }];
    expect(buildPrompt(input).text).toContain(`${PROFILE_SECTION_CAPTION}\n- hobby_builder: true`);
    expect(buildPrompt({ ...input, profileFacts: [] }).text).not.toContain(PROFILE_SECTION_CAPTION);
  });

  it("sends the memory index once while recall only moves known notes in and out of it (F6)", () => {
    const note = (id: number): MemoryEntry => ({ id, content: `note ${id} body`, createdAt: id, updatedAt: id, source: "agent",
      sessionId: null, workingDir: null, tags: ["reflection"], recallCount: 0, lastRecalledAt: null });
    const row = (id: number): MemoryIndexEntry => ({ id, preview: `note ${id}`, tags: ["reflection"], updatedAt: id, workingDir: null, sessionId: null });
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    // Journal entries only: the stable prefix also names the section.
    const indexCount = (text: string) => text.split("### memory-index\nContext update").length - 1;
    const input = fixture();
    const step = () => {
      const built = buildPrompt(input);
      input.session.cloudContext = built.cloudContext;
      return built;
    };
    // Turn start, as in the traces: three recalled, the next twenty in the index.
    input.session.recalledNotes = [note(34), note(33), note(12)];
    input.session.memoryIndex = range(13, 32).map(row);
    const first = step();
    expect(indexCount(first.text)).toBe(1);
    // After a step, recall comes back empty: its notes slide into the index, the oldest drop out.
    input.session.turns.push(assistantToolCallTurn({ tool: "fusion.delegate", args: {}, at: 2 }), toolResultTurn({ tool: "fusion.delegate", status: "ok", summary: "1 task: 1 ok", at: 3 }));
    input.session.recalledNotes = [];
    input.session.memoryIndex = range(15, 34).map(row);
    const second = step();
    expect(indexCount(second.text)).toBe(1);
    expect(second.text).toContain("### recalled\nContext update state:");
    expect(second.text).toContain("(no longer active)");
    expect(native(second).slice(0, native(first).length)).toEqual(native(first));
    // An older note sliding in is not news either.
    input.session.turns.push(assistantToolCallTurn({ tool: "verify.run", args: {}, at: 4 }), toolResultTurn({ tool: "verify.run", status: "ok", summary: "ok", at: 5 }));
    input.session.memoryIndex = [row(11), ...range(13, 31).map(row)];
    const third = step();
    expect(indexCount(third.text)).toBe(1);
    expect(third.cloudContext?.entries).toHaveLength((second.cloudContext?.entries.length ?? 0) + 2);
    // Restored from disk, the journal still keeps the index it sent.
    expect(buildPrompt({ ...input, session: JSON.parse(JSON.stringify(input.session)) }).text).toBe(third.text);
    // A note written since is news: the whole index goes out again.
    input.session.turns.push(assistantReplyTurn("done", 6), userTurn("next", 7));
    input.session.memoryIndex = range(16, 35).map(row);
    const fourth = step();
    expect(indexCount(fourth.text)).toBe(2);
    expect(fourth.text).toMatch(/### memory-index\nContext update state:\d+; supersedes state:\d+\.\n- #16 \[reflection\] note 16\n[\s\S]*- #35 \[reflection\] note 35/);
  });

  it("sends the memory index again after it was dropped", () => {
    const row = (id: number): MemoryIndexEntry => ({ id, preview: `note ${id}`, tags: [], updatedAt: id, workingDir: null, sessionId: null });
    const input = fixture();
    input.session.memoryIndex = [row(1), row(2)];
    input.session.cloudContext = buildPrompt(input).cloudContext;
    input.session.memoryIndex = [];
    const dropped = buildPrompt(input);
    expect(dropped.text).toContain("(no longer active)");
    input.session.cloudContext = dropped.cloudContext;
    input.session.memoryIndex = [row(1)];
    expect(buildPrompt(input).text.split("### memory-index\nContext update")).toHaveLength(4);
  });

  it("puts the current turn's call reasoning on the outgoing cloud turns, not in the journal (ATO-1397)", () => {
    const input = fixture();
    input.session.turns.push(
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: "a" }, reasoning: "zq-ato1397-reasoning", at: 2 }),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "A", at: 3 }),
    );
    const first = buildPrompt(input);
    const call = first.messages.turns.find((turn) => turn.kind === "assistant_tool_call");
    expect(call).toMatchObject({ reasoning: "zq-ato1397-reasoning" });
    expect(JSON.stringify(first.cloudContext)).not.toContain("zq-ato1397-reasoning");
    expect(first.text).not.toContain("zq-ato1397-reasoning");
    // A body that does not hand reasoning back is unchanged.
    expect(JSON.stringify(native(first))).not.toContain("reasoning_content");

    input.session.cloudContext = first.cloudContext;
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("next", 5));
    const second = buildPrompt(input);
    const answered = second.messages.turns.find((turn) => turn.kind === "assistant_tool_call");
    expect(answered).not.toHaveProperty("reasoning");
  });

  it("sends DeepSeek the turn's reasoning_content from session to wire (ATO-1397)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ model: "deepseek-v4-flash", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const deepseek = new OpenAiProvider({ id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "",
      defaultChatModel: "deepseek-v4-flash", fetchImpl: fetchImpl as unknown as typeof fetch });
    const tools = [{ type: "function" as const, function: { name: "os__fs__read", parameters: { type: "object", properties: {} } } }];
    const send = async (prompt: ReturnType<typeof buildPrompt>) => {
      await deepseek.complete({ prompt: prompt.text, messages: prompt.messages, tools, modelMode: mode,
        ...(prompt.contextBudget ? { contextBudget: prompt.contextBudget } : {}) });
      const sent = bodies[bodies.length - 1]!.messages as Array<Record<string, unknown>>;
      return sent.filter((m) => m.role === "assistant" && m.tool_calls !== undefined);
    };

    const input = fixture();
    input.session.turns.push(
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: "a" }, reasoning: "need a", at: 2 }),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "A", at: 3 }),
    );
    const step = buildPrompt(input);
    expect((await send(step)).map((m) => m.reasoning_content)).toEqual(["need a"]);

    // First step of the next turn: the answered call still carries the field.
    input.session.cloudContext = step.cloudContext;
    input.session.turns.push(assistantReplyTurn("done", 4), userTurn("next", 5));
    expect((await send(buildPrompt(input))).map((m) => m.reasoning_content)).toEqual([""]);
  });
});
