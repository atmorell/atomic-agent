import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { CancelledError } from "../../llm/index.js";
import { classifyVerifyResult } from "../../tools/fusion/autoverify.js";
import { confineReads } from "../../tools/read-scope/confine-reads.js";
import { ToolRegistry, type ToolContext } from "../../tools/tool-registry.js";
import { buildVerifyRunTool } from "../../tools/verify/verify-run.js";
import { dispatchNestedToolCall } from "./nested-tool-dispatch.js";

const CONFIG: Pick<AtomicAgentConfig, "browser"> = {
  browser: {
    enabled: true,
    channel: "chrome",
    headless: true,
    cdpUrl: null,
    connect: "agent",
    userChromeDataDir: null,
    executablePath: null,
    noSandbox: false,
    launchTimeoutMs: 1_000,
    blockedDomains: [],
    allowedDomains: [],
  },
};

function gate(approved: boolean): { gate: ApprovalGate; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ approved, reason: "test" }));
  return {
    gate: { request, fanoutScopes: { allows: () => false } } as unknown as ApprovalGate,
    request,
  };
}

let work: string;
let outside: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "nested-dispatch-work-"));
  outside = mkdtempSync(join(tmpdir(), "nested-dispatch-marker-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function ctx(signal = new AbortController().signal): ToolContext {
  return { workingDir: work, sessionId: "s1", stepIndex: 0, signal };
}

/** A verify that leaves a marker at an absolute path when it runs. */
function markerVerify(marker: string, extra: string[] = []): Record<string, unknown> {
  return {
    kind: "command",
    cmd: process.execPath,
    args: ["-e", "require('fs').writeFileSync(process.argv[1], 'ran')", marker, ...extra],
    checks: ["exit 0"],
  };
}

function registryWith(g: ApprovalGate): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(buildVerifyRunTool({ approvals: g, approvalRequired: true, config: CONFIG }));
  return registry;
}

describe("dispatchNestedToolCall (autoverify's verify.run)", () => {
  it("runs an approved verify through the registry", async () => {
    const g = gate(true);
    const marker = join(outside, "ran.txt");
    const result = await dispatchNestedToolCall({
      registry: registryWith(g.gate),
      tool: "verify.run",
      args: markerVerify(marker),
      ctx: ctx(),
      toolHooks: null,
    });
    expect(g.request).toHaveBeenCalledOnce();
    expect(classifyVerifyResult(result)).toMatchObject({ ran: true, ok: true, exitCode: 0 });
    expect(existsSync(marker)).toBe(true);
  });

  it("an approval denial is an error result, and the command never runs", async () => {
    const g = gate(false);
    const marker = join(outside, "ran.txt");
    const result = await dispatchNestedToolCall({
      registry: registryWith(g.gate),
      tool: "verify.run",
      args: markerVerify(marker),
      ctx: ctx(),
      toolHooks: null,
    });
    expect(result.status).toBe("error");
    expect(result.details.errorName).toBe("ApprovalDeniedError");
    expect(classifyVerifyResult(result).ran).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("a read-scope denial stops the call before verify.run's own ask", async () => {
    const prompts: ApprovalRequest[] = [];
    const real: ApprovalGate = new ApprovalGate({
      level: 1,
      emit: (req) => {
        prompts.push(req);
        queueMicrotask(() => real.resolve({ approvalId: req.approvalId, approved: false }));
      },
    });
    const registry = registryWith(real);
    // The shell check questions paths in the user's area (a home, or
    // the folder homes live in) outside the working directory.
    const home = join(parse(work).root, "srv", "homes", "me");
    confineReads(registry, {
      grantedDirs: () => [],
      readScope: () => "working-dir",
      approvals: { approvals: real, approvalRequired: true },
      shellEnv: { home, platform: process.platform },
    });
    const marker = join(outside, "ran.txt");
    const elsewhere = join(home, "Documents", "secret.txt");
    const result = await dispatchNestedToolCall({
      registry,
      tool: "verify.run",
      args: markerVerify(marker, [elsewhere]),
      ctx: ctx(),
      toolHooks: null,
    });
    // The ladder's refusal is a result, not a throw: no `kind`, so it did not run.
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "read-outside-scope", deniedByUser: true });
    expect(prompts.map((p) => p.category)).toEqual(["fs_read_outside"]);
    expect(classifyVerifyResult(result).ran).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an unknown key before dispatch, as for a model-emitted call", async () => {
    const g = gate(true);
    const result = await dispatchNestedToolCall({
      registry: registryWith(g.gate),
      tool: "verify.run",
      args: { ...markerVerify(join(outside, "ran.txt")), bogus: 1 },
      ctx: ctx(),
      toolHooks: null,
    });
    expect(result.status).toBe("error");
    expect(g.request).not.toHaveBeenCalled();
    expect(classifyVerifyResult(result).ran).toBe(false);
  });

  it("a cancelled signal surfaces as CancelledError", async () => {
    const controller = new AbortController();
    const g = gate(true);
    g.request.mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted while asking");
    });
    await expect(
      dispatchNestedToolCall({
        registry: registryWith(g.gate),
        tool: "verify.run",
        args: markerVerify(join(outside, "ran.txt")),
        ctx: ctx(controller.signal),
        toolHooks: null,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(existsSync(join(outside, "ran.txt"))).toBe(false);
  });
});
