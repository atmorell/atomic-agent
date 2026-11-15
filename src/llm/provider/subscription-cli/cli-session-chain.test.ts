import { describe, expect, it } from "vitest";

import { renderCloudTurn } from "../../../session/cloud-context.js";
import {
  JUDGE_FIXED_PART_END,
  planCliSessionTurn,
  REPEAT_NOTICE,
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

  it("starts a new session when the same prompt is sent again", () => {
    const previous = answered(prompt(HEAD));
    const turn = planCliSessionTurn("BASE", prompt(HEAD), previous, () => "new");

    expect(turn?.resume).toBe(false);
    expect(turn?.id).toBe("new");
    expect(turn?.input).toBe(`${HEAD}${TAIL}`);
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

describe("planCliSessionTurn for a fusion judge call (k3c, 16-11-2026)", () => {
  const RULES = "You are a strict judge.\nAnswer with JSON only.";
  const CASE = "## The case to judge\nA worker says it finished the task below.\n## Evidence\n### a.py\nx = 1";
  const judgePrompt = `${RULES}\n\n${CASE}`;

  it("puts the judge's rules in the system prompt and sends the case", () => {
    expect(planCliSessionTurn("BASE", judgePrompt, undefined, ids())).toEqual({
      id: "id-1",
      resume: false,
      system: `BASE\n\n${RULES}`,
      user: CASE,
      input: CASE,
    });
  });

  it("splits at whichever known heading comes first", () => {
    const quoted = `${judgePrompt}\n### notes.md\n### capabilities\nworking_dir: /w`;
    expect(planCliSessionTurn("BASE", quoted, undefined, ids())?.system).toBe(`BASE\n\n${RULES}`);
    const agent = prompt(`${HEAD}\ntool_result[fs.read] (ok): ${JUDGE_FIXED_PART_END}`);
    expect(planCliSessionTurn("BASE", agent, undefined, ids())?.system).toBe(`BASE\n\n${FIXED}`);
  });

  it("resumes the retry round with only its follow-up", () => {
    const followUp = "\n\n## Follow-up: the workers retried\n### a.py (changed since your ruling, shown whole)\nx = 2";
    const previous = answered(judgePrompt, '{"red":[{"id":"a1","why":"x is 1"}],"pass":[]}');
    for (const options of [{}, { resumeAcrossRepair: true }]) {
      const turn = planCliSessionTurn("BASE", `${judgePrompt}${followUp}`, previous, ids(), options);
      expect(turn).toEqual({
        id: previous.id,
        resume: true,
        system: previous.system,
        user: `${CASE}${followUp}`,
        input: followUp,
      });
    }
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

describe("planCliSessionTurn with resumeAcrossRepair", () => {
  const LENIENT = { resumeAcrossRepair: true };
  // `buildToolCallRepairPrompt`: the rejected prompt plus a repair
  // section, with the opener moved past it and no trailing newline.
  const REPAIR_SECTION =
    "\n### tool-call-repair\nThe previous answer was not a valid tool call.\n" +
    "### respond\nRespond now.\n";
  const repairPrompt = (conversation: string) =>
    `${FIXED}\n\n${conversation}${REPAIR_SECTION}<think>`;
  const link = (
    turn: ReturnType<typeof planCliSessionTurn>,
    answer: string,
  ): CliSessionLink => ({
    id: turn!.id,
    system: turn!.system,
    user: turn!.user,
    answer,
    ...(turn!.before ? { before: turn!.before } : {}),
  });

  it("sends a repair as a side turn of the same session", () => {
    const previous = answered(prompt(HEAD), "Reading the file first.");
    const turn = planCliSessionTurn(
      "BASE",
      repairPrompt(HEAD),
      previous,
      ids(),
      LENIENT,
    );

    expect(turn?.resume).toBe(true);
    expect(turn?.id).toBe(previous.id);
    // Only the repair is new; the shared newline stays behind.
    expect(turn?.input).toBe(`${REPAIR_SECTION.slice(1)}<think>`);
    expect(turn?.before).toBe(previous);
  });

  it("continues the call after a repair from the conversation before it", () => {
    const first = answered(prompt(HEAD), "Reading the file first.");
    const repair = planCliSessionTurn(
      "BASE",
      repairPrompt(HEAD),
      first,
      ids(),
      LENIENT,
    );
    const next = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\n${CALL_LINE}${RESULT_LINE}`),
      link(repair, ANSWER),
      ids(),
      LENIENT,
    );

    expect(next?.resume).toBe(true);
    expect(next?.id).toBe(first.id);
    // The repair's answer already stands in the session.
    expect(next?.input).toBe(`${RESULT_LINE}${TAIL}`);
    expect(next?.before).toBeUndefined();
  });

  it("resumes an identical re-send with a short repair notice", () => {
    const previous = answered(prompt(HEAD), "Reading the file first.");
    const turn = planCliSessionTurn(
      "BASE",
      prompt(HEAD),
      previous,
      ids(),
      LENIENT,
    );

    expect(turn).toEqual({
      id: previous.id,
      resume: true,
      system: previous.system,
      user: previous.user,
      input: REPEAT_NOTICE,
    });
  });

  it("changes nothing for a plain next call", () => {
    const previous = answered(prompt(HEAD));
    const next = prompt(`${HEAD}\n${CALL_LINE}${RESULT_LINE}`);
    expect(planCliSessionTurn("BASE", next, previous, ids(), LENIENT)).toEqual(
      planCliSessionTurn("BASE", next, previous, ids()),
    );
  });

  it("opens new sessions for both calls without the flag", () => {
    const first = answered(prompt(HEAD), "Reading the file first.");
    const repair = planCliSessionTurn(
      "BASE",
      repairPrompt(HEAD),
      first,
      () => "r",
    );
    const next = planCliSessionTurn(
      "BASE",
      prompt(`${HEAD}\n${CALL_LINE}${RESULT_LINE}`),
      link(repair, ANSWER),
      () => "n",
    );

    expect(repair).toMatchObject({ id: "r", resume: false });
    expect(next).toMatchObject({ id: "n", resume: false });
  });
});
