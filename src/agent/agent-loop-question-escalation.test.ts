import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent } from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { createTraceRecorder } from "../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../tracing/trace/trace-event.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";
import type { QuestionConsult } from "./policies/question-escalation.js";

/**
 * Kodevagten through the loop: in a fusion orchestrator turn, a sole
 * reply that asks the person something goes to the question model
 * first. Answered, the reply is kept as an interim note and the turn
 * goes on with the answer as its notice; otherwise the question closes
 * the turn as before.
 */

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const reply = (text: string): string => JSON.stringify([{ tool: "reply", args: { text } }]);
const QUESTION = reply("I found two ways to store the audiobooks. Should I use SQLite or JSON files?");
const FINAL = reply("Stored the audiobooks in SQLite.");

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

describe("AgentLoop: the orchestrator's question goes to the question model first", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-question-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(
    script: (call: number) => string,
    answers: string[],
    options: { fusion?: boolean; maxPerTurn?: number } = {},
  ) {
    const prompts: string[] = [];
    const consulted: string[] = [];
    const events: AgentLoopEvent[] = [];
    const trace: TraceEvent[] = [];
    const recorder = createTraceRecorder({
      sessionId: "s-q",
      emit: (event) => trace.push(event),
      now: () => 0,
    });
    let call = 0;
    const consult: QuestionConsult = async ({ prompt }) => {
      consulted.push(prompt);
      return {
        content: answers[consulted.length - 1] ?? "CANNOT: no more answers",
        providerId: "fable",
        model: "claude-fable-5-1",
        costUsd: 0.02,
      };
    };
    const agent = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params: LlmStreamParams) => {
        prompts.push(params.prompt);
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      isFusionMode: () => options.fusion ?? true,
      questionEscalation: () => ({ consult, maxPerTurn: options.maxPerTurn ?? 3 }),
      onEvent: (event) => {
        events.push(event);
        recorder.onAgentEvent(event);
      },
    });
    return { agent, prompts, consulted, events, trace };
  }

  const run = (agent: AgentLoop, id: string) =>
    agent.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "add audiobooks to the film agent",
      maxSteps: 6,
      autoContinue: false,
      signal: new AbortController().signal,
    });

  const escalations = (events: AgentLoopEvent[]) =>
    events.flatMap((e) =>
      e.type === "llm_event" && e.event.type === "question_escalated" ? [e.event] : [],
    );

  it("answered: keeps the question as a note and goes on with the answer", async () => {
    const { agent, prompts, consulted, events, trace } = loop(
      (call) => (call === 1 ? QUESTION : FINAL),
      ["ANSWER: Use SQLite; the agent already ships it."],
    );
    const result = await run(agent, "s-q-answered");
    expect(result.reason).toBe("reply");
    expect(consulted).toHaveLength(1);
    expect(consulted[0]).toContain("add audiobooks to the film agent");
    expect(consulted[0]).toContain("Should I use SQLite or JSON files?");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Use SQLite; the agent already ships it.");
    expect(prompts[1]).toContain("claude-fable-5-1");
    const replies = result.session.turns.filter((t) => t.kind === "assistant_reply");
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ progressNote: true });
    expect(replies[1]).toMatchObject({ text: "Stored the audiobooks in SQLite." });
    expect(replies[1]).not.toHaveProperty("progressNote");
    expect(escalations(events)).toEqual([
      expect.objectContaining({
        outcome: "answered",
        providerId: "fable",
        model: "claude-fable-5-1",
        costUsd: 0.02,
        stepIndex: 0,
      }),
    ]);
    expect(trace.filter((e) => e.type === "question_escalated")).toEqual([
      expect.objectContaining({ outcome: "answered", model: "claude-fable-5-1" }),
    ]);
  });

  it("cannot: the question closes the turn and reaches the person", async () => {
    const { agent, prompts, consulted, events } = loop(
      () => QUESTION,
      ["CANNOT: which storage the person prefers is theirs to say"],
    );
    const result = await run(agent, "s-q-cannot");
    expect(result.reason).toBe("reply");
    expect(consulted).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    const last = result.session.turns.at(-1);
    expect(last).toMatchObject({ kind: "assistant_reply" });
    expect(last).not.toHaveProperty("progressNote");
    expect(escalations(events)[0]).toMatchObject({ outcome: "cannot" });
  });

  it("a reply that asks nothing is not sent", async () => {
    const { agent, consulted, prompts } = loop(() => FINAL, ["ANSWER: x"]);
    const result = await run(agent, "s-q-plain");
    expect(result.reason).toBe("reply");
    expect(consulted).toHaveLength(0);
    expect(prompts).toHaveLength(1);
  });

  it("stops consulting at the turn's cap", async () => {
    const { agent, consulted, prompts } = loop(
      () => QUESTION,
      ["ANSWER: go on", "ANSWER: go on"],
      { maxPerTurn: 1 },
    );
    const result = await run(agent, "s-q-cap");
    expect(result.reason).toBe("reply");
    expect(consulted).toHaveLength(1);
    expect(prompts).toHaveLength(2);
  });

  it("is off outside a fusion orchestrator turn", async () => {
    const { agent, consulted } = loop(() => QUESTION, ["ANSWER: go on"], { fusion: false });
    const result = await run(agent, "s-q-off");
    expect(result.reason).toBe("reply");
    expect(consulted).toHaveLength(0);
  });
});
