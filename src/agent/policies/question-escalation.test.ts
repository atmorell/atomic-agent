import { describe, expect, it } from "vitest";

import {
  createQuestionGate,
  formatQuestionAnswerNotice,
  looksLikeQuestion,
  parseQuestionAnswer,
  renderQuestionPrompt,
  renderRecentWork,
  type QuestionConsult,
} from "./question-escalation.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";

const signal = () => new AbortController().signal;

describe("looksLikeQuestion", () => {
  it("is a question when a ? sits in the reply's last lines", () => {
    expect(looksLikeQuestion("Two options. Should I use SQLite?")).toBe(true);
    expect(looksLikeQuestion("Done. Tests ran green.")).toBe(false);
  });

  it("ignores ? in code, inline code and links", () => {
    expect(looksLikeQuestion("Ran `a ? b : c` fine.")).toBe(false);
    expect(looksLikeQuestion("```\nx = y ? 1 : 2\n```\nDone.")).toBe(false);
    expect(looksLikeQuestion("See https://example.com/?q=1 for it.")).toBe(false);
  });

  it("does not count a question quoted early in a long report", () => {
    const report = `The ticket asked: why does it fail?\n${"Fixed and verified. ".repeat(40)}`;
    expect(looksLikeQuestion(report)).toBe(false);
  });
});

describe("parseQuestionAnswer", () => {
  it("reads ANSWER and CANNOT, tolerating bold and case", () => {
    expect(parseQuestionAnswer("ANSWER: use A")).toEqual({ kind: "answered", text: "use A" });
    expect(parseQuestionAnswer("**answer:** use A")).toEqual({ kind: "answered", text: "use A" });
    expect(parseQuestionAnswer("CANNOT: their taste")).toEqual({ kind: "cannot", text: "their taste" });
  });

  it("treats anything unclear as cannot", () => {
    expect(parseQuestionAnswer("")).toMatchObject({ kind: "cannot" });
    expect(parseQuestionAnswer("I think A")).toMatchObject({ kind: "cannot" });
    expect(parseQuestionAnswer("ANSWER:   ")).toMatchObject({ kind: "cannot" });
  });
});

describe("renderQuestionPrompt", () => {
  it("carries the request, the work and the question, and the CANNOT rules", () => {
    const prompt = renderQuestionPrompt({
      question: "Should I deploy?",
      request: "add audiobooks",
      work: "- call os.fs.read {}",
    });
    expect(prompt).toContain("add audiobooks");
    expect(prompt).toContain("- call os.fs.read {}");
    expect(prompt).toContain("Should I deploy?");
    expect(prompt).toMatch(/cannot be undone or leaves this machine/);
    expect(prompt).toContain("CANNOT:");
  });
});

describe("renderRecentWork", () => {
  it("starts after the last request, not at a mid-turn steer", () => {
    const turns = [
      { kind: "user", text: "old request" },
      { kind: "assistant_reply", text: "old answer" },
      { kind: "user", text: "new request" },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.ts" } },
      { kind: "tool_result", status: "ok", summary: "read 10 lines" },
      { kind: "user", text: "use tabs", steered: true },
    ] as unknown as ConversationTurn[];
    const work = renderRecentWork(turns);
    expect(work).not.toContain("old answer");
    expect(work).toContain("os.fs.read");
    expect(work).toContain("read 10 lines");
    expect(work).toContain("person (mid-turn): use tabs");
  });
});

describe("createQuestionGate", () => {
  const ask = (gate: ReturnType<typeof createQuestionGate>, s = signal()) =>
    gate.consult({ question: "A or B?", request: "r", turns: [], signal: s, sessionId: "s" });

  it("counts every consult against the cap", async () => {
    const consult: QuestionConsult = async () => ({
      content: "ANSWER: A",
      providerId: "fable",
      model: "claude-fable-5-1",
      costUsd: 0.01,
    });
    const gate = createQuestionGate(consult, 2);
    expect(gate.remaining()).toBe(2);
    expect(await ask(gate)).toEqual({
      kind: "answered",
      answer: "A",
      providerId: "fable",
      model: "claude-fable-5-1",
      costUsd: 0.01,
    });
    await ask(gate);
    expect(gate.remaining()).toBe(0);
  });

  it("turns a failed call into failed, but lets a cancel through", async () => {
    const consult: QuestionConsult = async () => {
      throw new Error("rate limited");
    };
    const gate = createQuestionGate(consult, 3);
    expect(await ask(gate)).toEqual({ kind: "failed", reason: "rate limited" });
    const ctl = new AbortController();
    ctl.abort();
    await expect(ask(gate, ctl.signal)).rejects.toThrow("rate limited");
  });
});

describe("formatQuestionAnswerNotice", () => {
  it("names the model and tells the orchestrator to carry on", () => {
    const notice = formatQuestionAnswerNotice("claude-fable-5-1", "Use A.");
    expect(notice).toContain("claude-fable-5-1");
    expect(notice).toContain("Use A.");
    expect(notice).toMatch(/Carry on/);
  });
});
