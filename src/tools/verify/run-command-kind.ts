/**
 * `kind: "command"` — any test runner, compiler, script or CLI, run to
 * completion in the throwaway copy.
 */
import type { MemoryGuardReason } from "../../sandbox/memory-guard.js";
import type { VerifyRunArgs } from "./verify-run-args.js";
import { spawnVerifyProcess } from "./spawn-verify-process.js";

export interface CommandRunOutcome {
  readonly commandLine: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: string;
  /** Killed by the memory guard (see `SpawnVerifyOptions.memoryLimitBytes`). */
  readonly memoryLimitHit?: MemoryGuardReason;
  readonly memoryPeakBytes?: number;
  /** Full captured output (capped) — for checks. */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export async function runCommandKind(
  args: VerifyRunArgs,
  ctx: { cwd: string; signal?: AbortSignal; memoryLimitBytes?: number },
): Promise<CommandRunOutcome> {
  const started = Date.now();
  const proc = spawnVerifyProcess(args.cmd ?? "", args.args ?? [], {
    cwd: ctx.cwd,
    env: args.env,
    network: args.network,
    timeoutMs: args.timeoutMs,
    signal: ctx.signal,
    ...(ctx.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: ctx.memoryLimitBytes }),
  });
  const exit = await proc.exited;
  return {
    commandLine: proc.commandLine,
    // A tree the guard killed has no exit code of its own: on Windows
    // taskkill /F leaves exit 1, which an `exit != 0` check would pass.
    exitCode: exit.memoryLimitHit === undefined ? exit.exitCode : null,
    signal: exit.signal,
    timedOut: exit.timedOut,
    aborted: exit.aborted,
    ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
    ...(exit.memoryLimitHit === undefined ? {} : { memoryLimitHit: exit.memoryLimitHit }),
    ...(exit.memoryPeakBytes === undefined ? {} : { memoryPeakBytes: exit.memoryPeakBytes }),
    stdout: proc.stdout.all(),
    stderr: proc.stderr.all(),
    stdoutTail: proc.stdout.tail(),
    stderrTail: proc.stderr.tail(),
    durationMs: Date.now() - started,
  };
}
