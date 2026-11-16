import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { AgentLoopEvent } from "../../../agent/agent-loop.js";
import type { CompressedToolResult } from "../../../compressor/result-compressor.js";
import { resolveContractOwners } from "../../fusion/contract-inputs.js";
import { WorkerRunCollector } from "../../fusion/worker-result.js";
import type { ToolContext } from "../../tool-registry.js";
import { DeclaredInputsRegistry } from "./fs-declared-inputs.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsMoveTool } from "./fs-move.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { buildOsFsRestoreTool } from "./fs-restore.js";
import { FileRestoreStore } from "./fs-restore-store.js";
import { buildOsFsWriteTool } from "./fs-write.js";

/**
 * k8e (16-11-2026): the contract's `owners` said "nobody else writes
 * there", and only the prompt said it. The core worker wrote the CLI
 * worker's `__main__.py`; the judge read it as a stray and sent the
 * task back. Pinned here: every file tool refuses a path the contract
 * gives another task, before the approval prompt, and the refusal never
 * reaches the judge's record of what the worker wrote.
 */
describe("owner guard (k8e)", () => {
  let dir: string;
  let stateDir: string;
  let prompts: ApprovalRequest[];
  let gate: ApprovalGate;
  let registry: DeclaredInputsRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-owner-guard-"));
    stateDir = await mkdtemp(join(tmpdir(), "atomic-owner-guard-state-"));
    prompts = [];
    gate = new ApprovalGate({
      emit: (req) => {
        prompts.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    registry = new DeclaredInputsRegistry();
    await mkdir(join(dir, "ark"), { recursive: true });
    arm("s-kerne", "kerne");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const OWNERS = {
    "ark/core.py": "kerne",
    "ark/cli.py": "cli",
    "ark/__main__.py": "cli",
  };

  /** What `armWorkerSession` does for a worker of `taskId`. */
  function arm(sessionId: string, taskId: string, owners: Record<string, string> = OWNERS): void {
    const resolved = resolveContractOwners(owners, taskId, dir);
    if (resolved !== null) registry.declareForeign(sessionId, resolved.foreign, resolved.own);
  }

  function ctx(sessionId = "s-kerne"): ToolContext {
    return {
      workingDir: dir,
      sessionId,
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  function options(restore?: FileRestoreStore) {
    return {
      approvals: gate,
      approvalRequired: true,
      declaredInputs: registry,
      ...(restore === undefined ? {} : { restore }),
    };
  }

  const REFUSAL =
    'refused: ark/__main__.py belongs to task "cli" in this fan-out\'s contract; only that task writes it. Nothing was written. Do not retry this path or write the content elsewhere — build against the names the CONTRACT gives and say in your reply what you needed from ark/__main__.py.';

  it("refuses a write of another task's path before the prompt, whatever overwrite says, and writes nothing", async () => {
    const result = await buildOsFsWriteTool(options()).run(
      { path: "ark/__main__.py", content: "from ark.cli import main\n", overwrite: true },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toBe(REFUSAL);
    expect(result.details).toMatchObject({
      refused: "owner",
      owner: "cli",
      path: join(dir, "ark", "__main__.py"),
      display: "ark/__main__.py",
    });
    expect(prompts).toHaveLength(0);
    expect(existsSync(join(dir, "ark", "__main__.py"))).toBe(false);
  });

  it("refuses an edit, an applied patch, a move onto or off it, and a restore; a dry-run patch is fine", async () => {
    const main = join(dir, "ark", "__main__.py");
    const original = "from ark.cli import main\nmain()\n";
    await writeFile(main, original, "utf8");

    const edit = await buildOsFsEditTool(options()).run(
      { path: "ark/__main__.py", oldString: "main()", newString: "main(argv)" },
      ctx(),
    );
    expect(edit.status).toBe("error");
    expect(edit.summary).toBe(REFUSAL);

    const patch = createPatch("ark/__main__.py", original, "from ark.cli import main\nmain([])\n");
    const patchTool = buildOsFsPatchTool(options());
    const dry = await patchTool.run({ patch, stripComponents: 0 }, ctx());
    expect(dry.status).toBe("ok");
    expect(dry.details.mode).toBe("dry-run");
    const applied = await patchTool.run({ patch, stripComponents: 0, apply: true }, ctx());
    expect(applied.status).toBe("error");
    expect(applied.summary).toBe(REFUSAL);

    await writeFile(join(dir, "stub.py"), "pass\n", "utf8");
    const move = buildOsFsMoveTool(options());
    const onto = await move.run({ moves: [{ from: "stub.py", to: "ark/__main__.py" }], overwrite: true }, ctx());
    expect(onto.status).toBe("error");
    const off = await move.run({ moves: [{ from: "ark/__main__.py", to: "old_main.py" }] }, ctx());
    expect(off.status).toBe("error");

    const restore = await buildOsFsRestoreTool(
      options(new FileRestoreStore(join(stateDir, "restore"))),
    ).run({ path: "ark/__main__.py" }, ctx());
    expect(restore.status).toBe("error");
    expect(restore.summary).toBe(REFUSAL);

    expect(prompts).toHaveLength(0);
    expect(await readFile(main, "utf8")).toBe(original);
    expect(existsSync(join(dir, "stub.py"))).toBe(true);
  });

  it("lets a task write its own paths and any path no task owns", async () => {
    const write = buildOsFsWriteTool(options());
    expect((await write.run({ path: "ark/core.py", content: "X = 1\n" }, ctx())).status).toBe("ok");
    expect((await write.run({ path: "notes.md", content: "n\n" }, ctx())).status).toBe("ok");
  });

  it("lets a retry of the same task and a subtask of a split write what their task owns", async () => {
    arm("s-cli-retry", "cli");
    arm("s-cli-part", "cli/part-a");
    const write = buildOsFsWriteTool(options());
    expect(
      (await write.run({ path: "ark/__main__.py", content: "a\n" }, ctx("s-cli-retry"))).status,
    ).toBe("ok");
    expect(
      (await write.run({ path: "ark/cli.py", content: "b\n" }, ctx("s-cli-part"))).status,
    ).toBe("ok");
    expect(
      (await write.run({ path: "ark/core.py", content: "c\n" }, ctx("s-cli-part"))).status,
    ).toBe("error");
  });

  it("arms nothing without owners, for a task that owns them all, or for autoverify's repair worker", () => {
    expect(resolveContractOwners(undefined, "kerne", dir)).toBeNull();
    expect(resolveContractOwners({ "ark/core.py": "kerne" }, "kerne", dir)).toBeNull();
    expect(resolveContractOwners(OWNERS, "autoverify-repair-1", dir)).toBeNull();
    expect(resolveContractOwners({ "ark/*.py": "cli" }, "kerne", dir)).toBeNull();
  });

  it("leaves a session with no declaration alone, and forgets on clear", async () => {
    const write = buildOsFsWriteTool(options());
    expect(
      (await write.run({ path: "ark/cli.py", content: "x\n" }, ctx("s-plain"))).status,
    ).toBe("ok");
    registry.clear("s-kerne");
    expect(
      (await write.run({ path: "ark/cli.py", content: "y\n" }, ctx())).status,
    ).toBe("ok");
  });

  it("guards a folder another task owns, unless a more specific entry is this task's", () => {
    arm("s-a", "a", { pkg: "b", "pkg/mine.py": "a" });
    expect(registry.foreignOwnerOf("s-a", join(dir, "pkg", "theirs.py"))).toBe("b");
    expect(registry.foreignOwnerOf("s-a", join(dir, "pkg"))).toBe("b");
    expect(registry.foreignOwnerOf("s-a", join(dir, "pkg", "mine.py"))).toBeUndefined();
    expect(registry.foreignOwnerOf("s-a", join(dir, "pkgx", "f.py"))).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("compares case-insensitively on Windows", () => {
    expect(
      registry.foreignOwnerOf("s-kerne", join(dir, "ARK", "__MAIN__.py")),
    ).toBe("cli");
  });

  it("keeps a refused path out of what the judge reads as written", async () => {
    const write = buildOsFsWriteTool(options());
    const collector = new WorkerRunCollector();
    collector.observe(executed(await write.run({ path: "ark/__main__.py", content: "a\n" }, ctx())));
    collector.observe(executed(await write.run({ path: "ark/core.py", content: "b\n" }, ctx())));
    expect(collector.writtenPaths()).toEqual([join(dir, "ark", "core.py")]);
  });
});

function executed(result: CompressedToolResult): AgentLoopEvent {
  return {
    type: "llm_event",
    event: { type: "tool_call_executed", result, batchIndex: 0, batchSize: 1 },
  };
}
