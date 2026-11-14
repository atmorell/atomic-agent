import { describe, expect, it } from "vitest";

import { renderCloudTurn } from "../../../session/cloud-context.js";
import {
  DISCARDED_ANSWER_NOTE,
  planCliSessionTurn,
  restartCliSessionTurn,
  withoutOwnAnswer,
  type CliSessionLink,
} from "./cli-session-chain.js";

const FIXED = "### system 0\npersona\n\n### tools\nfs.read";
const HEAD = "### capabilities\nworking_dir: /w\n\n### conversation\nuser: do it";
const TAIL = "\n<think>\n";
const CALL = { tool: "fs.read", args: { path: "a.txt", lines: [1, 20] } };
const ANSWER = `${JSON.stringify([CALL])}\nReading the file first.`;
const CALL_LINE = `assistant_tool_call: fs.read ${JSON.stringify(CALL.args)}\n`;
const RESULT_LINE = "tool_result[fs.read] (ok): hello\n";

const ids = () => {
  let n = 0;
  return () => `id-${(n += 1)}`;
};

function prompt(conversation: string, fixed = FIXED): string {
  return `${fixed}\n\n${conversation}${TAIL}`;
}

function answered(first: string, answer = ANSWER): CliSessionLink {
  const turn = planCliSessionTurn("BASE", first, undefined, ids())!;
  return { id: turn.id, system: turn.system, user: turn.user, answer };
}

describe("planCliSessionTurn", () => {
  it("opens a session: the fixed part is the system prompt, the rest is sent", () => {
    const turn = planCliSessionTurn("BASE", prompt(HEAD), undefined, ids());

    expect(turn).toEqual({
      id: "id-1",
      resume: false,
      system: `BASE\n\n${FIXED}`,
      user: `${HEAD}${TAIL}`,
      input: `${HEAD}${TAIL}`,
    });
  });

  it("keeps the system prompt identical however the conversation grows", () => {
    const first = planCliSessionTurn("BASE", prompt(HEAD), undefined, ids());
    const later = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\n${CALL_LINE}${RESULT_LINE}`),
      undefined,
      ids(),
    );

    expect(later?.system).toBe(first?.system);
  });

  it("resumes with only what the conversation gained, minus its own answer", () => {
    const previous = answered(prompt(HEAD));
    const turn = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\n${CALL_LINE}${RESULT_LINE}`),
      previous,
      ids(),
    );

    expect(turn?.resume).toBe(true);
    expect(turn?.id).toBe(previous.id);
    expect(turn?.input).toBe(`${RESULT_LINE}${TAIL}`);
    // The link keeps the whole conversation, not just what was sent.
    expect(turn?.user).toBe(`${HEAD}\n${CALL_LINE}${RESULT_LINE}${TAIL}`);
  });

  it("asks again in the same session when the same prompt is sent again", () => {
    const previous = answered(prompt(HEAD));
    const turn = planCliSessionTurn("BASE", prompt(HEAD), previous, () => "new");

    expect(turn?.resume).toBe(true);
    expect(turn?.id).toBe(previous.id);
    expect(turn?.input).toBe(DISCARDED_ANSWER_NOTE);
    expect(turn?.user).toBe(`${HEAD}${TAIL}`);
  });

  it("starts a new session when earlier conversation was rewritten", () => {
    const previous = answered(prompt(`${HEAD}\n${"x".repeat(600)}`));
    const turn = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\nuser: summary of earlier turns\n${RESULT_LINE}`),
      previous,
      ids(),
    );

    expect(turn?.resume).toBe(false);
  });

  it("starts a new session when the fixed part changed", () => {
    const previous = answered(prompt(HEAD));
    const turn = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\n${RESULT_LINE}`, `${FIXED}\nfs.write`),
      previous,
      ids(),
    );

    expect(turn?.resume).toBe(false);
    expect(turn?.system).toBe(`BASE\n\n${FIXED}\nfs.write`);
  });

  it("leaves a prompt without the fixed part alone", () => {
    expect(planCliSessionTurn("BASE", "summarise this", undefined, ids())).toBeNull();
  });
});

describe("restartCliSessionTurn", () => {
  it("re-opens a refused resume as a new session with the whole conversation", () => {
    const previous = answered(prompt(HEAD));
    const turn = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\n${CALL_LINE}${RESULT_LINE}`),
      previous,
      ids(),
    )!;
    const fresh = restartCliSessionTurn(turn, () => "new");

    expect(fresh).toEqual({ ...turn, id: "new", resume: false, input: turn.user });
  });
});

describe("withoutOwnAnswer", () => {
  it("drops the line the conversation renders for the answer's tool call", () => {
    const rendered = renderCloudTurn({
      kind: "assistant_tool_call",
      tool: CALL.tool,
      args: CALL.args,
    });

    expect(withoutOwnAnswer(`${rendered}\n${RESULT_LINE}`, ANSWER)).toBe(RESULT_LINE);
  });

  it("drops every call of a batch, wherever its line stands", () => {
    const second = { tool: "verify.run", args: { command: "pytest -q" } };
    const answer = JSON.stringify([CALL, second]);
    const added =
      `${CALL_LINE}${RESULT_LINE}` +
      `assistant_tool_call: verify.run ${JSON.stringify(second.args)}\n` +
      "tool_result[verify.run] (ok): 4 passed\n";

    expect(withoutOwnAnswer(added, answer)).toBe(
      `${RESULT_LINE}tool_result[verify.run] (ok): 4 passed\n`,
    );
  });

  it("keeps a line that differs by a byte, or only quotes the call", () => {
    const other = `assistant_tool_call: fs.read {"path":"b.txt"}\n${RESULT_LINE}`;
    const quoted = `tool_result[x] (ok): saw ${CALL_LINE}`;

    expect(withoutOwnAnswer(other, ANSWER)).toBe(other);
    expect(withoutOwnAnswer(quoted, ANSWER)).toBe(quoted);
  });

  it("keeps everything when the answer is not a tool call", () => {
    const added = `${CALL_LINE}${RESULT_LINE}`;

    expect(withoutOwnAnswer(added, "I could not decide.")).toBe(added);
  });

  it("never sends an empty turn", () => {
    expect(withoutOwnAnswer(CALL_LINE, ANSWER)).toBe(CALL_LINE);
  });
});
