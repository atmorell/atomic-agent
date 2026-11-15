import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolContext, ToolRegistry } from "../../tools/tool-registry.js";
import { CancelledError } from "../../llm/index.js";
import { runWithApprovalWorkdir } from "../../approval/approval-workdir.js";
import { activeToolHooks, runWithToolHooks, type ToolHookEngine } from "../../hooks/hook-engine.js";
import { refuseBeforeDispatch } from "./batch-gates.js";

/**
 * One tool call a tool makes on the model's behalf (autoverify's
 * `verify.run` inside `fusion.delegate`), through the same dispatch
 * steps `executeBatch` gives a call the model emitted: the pre-dispatch
 * refusal (control markers, unknown keys), the PreToolUse / PostToolUse
 * hooks, the session's folder for approval rules, and the registry's
 * own wrappers looked up at call time (read scope, input-file
 * protection, the tool's approval ask). The caller's approval ledger
 * is the ambient one, so an approval this call raises is recorded on
 * the call that made it.
 *
 * A thrown error becomes an error result with `details.errorName`
 * (an approval denial is `ApprovalDeniedError`); a cancelled signal
 * throws `CancelledError`, as in `executeBatch`.
 */
export async function dispatchNestedToolCall(input: {
  registry: ToolRegistry;
  tool: string;
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** Absent ⇒ the engine installed at boot; `null` ⇒ no hooks. */
  toolHooks?: ToolHookEngine | null;
}): Promise<CompressedToolResult> {
  const { registry, tool, args, ctx } = input;
  const refusal = refuseBeforeDispatch({ tool, args });
  if (refusal !== null) return refusal;
  const invoke = async (): Promise<CompressedToolResult> => {
    try {
      return await runWithApprovalWorkdir(ctx.workingDir, () => registry.invoke(tool, args, ctx));
    } catch (err) {
      if (ctx.signal.aborted) {
        throw err instanceof CancelledError
          ? err
          : new CancelledError(err instanceof Error ? err.message : "operation cancelled", { cause: err });
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      return compressToolResult({
        tool,
        status: "error",
        output: cause.message,
        details: { errorName: cause.name },
      });
    }
  };
  const hooks = input.toolHooks === undefined ? activeToolHooks() : input.toolHooks;
  return runWithToolHooks(
    hooks,
    { tool, args, sessionId: ctx.sessionId, cwd: ctx.workingDir, signal: ctx.signal },
    invoke,
  );
}
