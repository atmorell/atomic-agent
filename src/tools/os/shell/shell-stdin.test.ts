import { readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import { readCommandRun } from "../../fusion/worker-result.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";
import {
  stdinAsInlineScript,
  stdinFeedsUnreadCommands,
} from "./shell-command-argv.js";
import {
  SHELL_STDIN_MAX_BYTES,
  STDIN_WITH_SUBSHELL_MESSAGE,
  parseShellStdin,
} from "./shell-stdin.js";

/**
 * k8e (16-11-2026): the core worker wrote a test file to drive its own
 * code, because a command had no input; the judge read the file as a
 * stray. Pinned here: `stdin` feeds a script to an interpreter in the
 * working directory without a file, every check reads that script as
 * the inline call it is, and what no check could read is refused.
 */
describe("stdinAsInlineScript / stdinFeedsUnreadCommands", () => {
  const S = "print(1)";

  it("puts the script on the line with each interpreter's own flag", () => {
    expect(stdinAsInlineScript("python", ["-"], S)).toEqual(["-c", S]);
    expect(stdinAsInlineScript("python3", ["-u", "-", "a"], S)).toEqual(["-c", S, "-u", "a"]);
    expect(stdinAsInlineScript("C:\\Python313\\python.exe", ["-"], S)).toEqual(["-c", S]);
    expect(stdinAsInlineScript("node", [], S)).toEqual(["-e", S]);
    expect(stdinAsInlineScript("ruby", ["-"], S)).toEqual(["-e", S]);
    expect(stdinAsInlineScript("php", [], S)).toEqual(["-r", S]);
    expect(stdinAsInlineScript("bash", [], S)).toEqual(["-c", S]);
    expect(stdinAsInlineScript("bash", ["-s"], S)).toEqual(["-c", S, "-s"]);
  });

  it("leaves data alone: a script file, inline code, or a program that only reads input", () => {
    expect(stdinAsInlineScript("python", ["run.py"], S)).toBeNull();
    expect(stdinAsInlineScript("python", ["-c", "x"], S)).toBeNull();
    expect(stdinAsInlineScript("python", ["-m", "json.tool"], S)).toBeNull();
    expect(stdinAsInlineScript("bash", ["run.sh"], S)).toBeNull();
    expect(stdinAsInlineScript("sort", [], S)).toBeNull();
  });

  it("flags input that would run as commands no check reads", () => {
    expect(stdinFeedsUnreadCommands("env", ["python", "-"])).toBe(true);
    expect(stdinFeedsUnreadCommands("sudo", ["bash"])).toBe(true);
    expect(stdinFeedsUnreadCommands("bash", ["-c", "sh"])).toBe(true);
    expect(stdinFeedsUnreadCommands("xargs", ["rm"])).toBe(true);
    expect(stdinFeedsUnreadCommands("cmd", [])).toBe(true);
    expect(stdinFeedsUnreadCommands("powershell.exe", ["-Command", "-"])).toBe(true);
    expect(stdinFeedsUnreadCommands("python", ["-"])).toBe(false);
    expect(stdinFeedsUnreadCommands("python", ["run.py"])).toBe(false);
    expect(stdinFeedsUnreadCommands("sort", [])).toBe(false);
  });

  it("reads blank as none and refuses a non-string or an oversized input", () => {
    expect(parseShellStdin(undefined)).toBeNull();
    expect(parseShellStdin(null)).toBeNull();
    expect(parseShellStdin("  \n")).toBeNull();
    expect(parseShellStdin(["print(1)"])).toMatchObject({ error: expect.stringContaining("must be a string") });
    expect(parseShellStdin("x".repeat(SHELL_STDIN_MAX_BYTES + 1))).toMatchObject({
      error: expect.stringContaining(`at most ${SHELL_STDIN_MAX_BYTES}`),
    });
    const fed = parseShellStdin("æ");
    expect(fed).toMatchObject({ text: "æ", bytes: 2 });
    expect((fed as { digest: string }).digest).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("os.shell.run with stdin (k8e)", () => {
  let dir: string;
  let prompts: ApprovalRequest[];
  let approve: boolean;
  let gate: ApprovalGate;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-stdin-"));
    prompts = [];
    approve = true;
    gate = new ApprovalGate({
      level: 1,
      emit: (req) => {
        prompts.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: approve });
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return {
      workingDir: dir,
      sessionId: "s-stdin",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  function tool() {
    return buildOsShellTool({ approvals: gate, approvalRequired: true });
  }

  const NODE = process.execPath;

  it("runs a script on stdin in the working directory, so its modules load, and writes no file", async () => {
    await writeFile(join(dir, "mod.js"), "exports.x = 42;\n", "utf8");
    const script = "const m = require('./mod.js'); console.log('got', m.x);";
    const result = await tool().run({ cmd: NODE, args: ["-"], stdin: script }, ctx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("got 42");
    expect(result.summary).toMatch(/< stdin \(\d+ bytes #[0-9a-f]{8}\)/);
    expect(result.summary).not.toContain("ran with no arguments");
    expect(result.details).toMatchObject({ stdinBytes: Buffer.byteLength(script) });
    expect(await readdir(dir)).toEqual(["mod.js"]);
    // Level 1 asks for an interpreter: the prompt shows the script and
    // the rules read it inline.
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt.preview).toContain(script);
      expect(prompt.commandSegments?.[0]).toEqual([NODE, "-e", script]);
    }
  });

  it("keeps two runs with different scripts apart in a worker's record of commands", async () => {
    const a = await tool().run({ cmd: NODE, args: ["-"], stdin: "console.log(1)" }, ctx());
    const b = await tool().run({ cmd: NODE, args: ["-"], stdin: "console.log(2)" }, ctx());
    const runA = readCommandRun(a);
    const runB = readCommandRun(b);
    expect(runA?.lines[0]).toMatch(/<stdin #[0-9a-f]{8}>$/);
    expect(runA?.lines[0]).not.toBe(runB?.lines[0]);
  });

  it("refuses stdin on a subshell line and in front of an unread interpreter, running nothing", async () => {
    const sub = await tool().run({ cmd: "echo hi | sort", stdin: "x" }, ctx());
    expect(sub.status).toBe("error");
    expect(sub.summary).toBe(STDIN_WITH_SUBSHELL_MESSAGE);
    const wrapped = await tool().run({ cmd: "env", args: ["python", "-"], stdin: "print(1)" }, ctx());
    expect(wrapped.status).toBe("error");
    expect(wrapped.summary).toContain("no check reads");
    expect(prompts).toHaveLength(0);
  });

  it("refuses a non-string and an oversized stdin before the guard", async () => {
    const bad = await tool().run({ cmd: NODE, args: ["-"], stdin: 42 }, ctx());
    expect(bad.status).toBe("error");
    const big = await tool().run(
      { cmd: NODE, args: ["-"], stdin: "x".repeat(SHELL_STDIN_MAX_BYTES + 1) },
      ctx(),
    );
    expect(big.status).toBe("error");
    expect(big.summary).toContain(`at most ${SHELL_STDIN_MAX_BYTES}`);
    expect(prompts).toHaveLength(0);
  });

  it(
    "guards `bash` with a script on stdin like `bash -c <script>`: a dangerous line asks as dangerous",
    async () => {
      approve = false;
      await expect(
        tool().run({ cmd: "bash", args: [], stdin: "rm -rf ./build" }, ctx()),
      ).rejects.toThrow();
      await expect(
        tool().run({ cmd: "bash", args: ["-c", "rm -rf ./build"] }, ctx()),
      ).rejects.toThrow();
      expect(prompts.map((p) => p.category)).toEqual(["shell_dangerous", "shell_dangerous"]);
    },
  );
});
