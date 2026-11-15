import { isAbsolute } from "node:path";

/**
 * Which files a session may edit in place but never replace — the
 * fan-out contract's `inputs` (F51), keyed by worker session — and which
 * session a worker belongs to.
 *
 * The same shape as `FanoutScopeRegistry`, for the same reason: a tool
 * sees only its `ToolContext`, so a fact about the session it runs in
 * has to be looked up by session id. The worker runner declares a
 * worker's inputs before its turn and clears them in the same `finally`
 * as its refuse policy; `os.fs.write` asks `inputsOf` before it
 * replaces anything (`fs-input-guard.ts`). An orchestrator or a plain
 * session never has an entry here, so the registry says nothing about
 * them — their inputs are the request's, checked by name.
 *
 * `link` ties a worker to its parent for the same lifetime, so a file
 * one worker of the parent created counts as the agent's for every
 * other (`FileRestoreStore`'s created set). Without it a judge's retry —
 * a new worker session — was refused the rewrite of a file the first
 * attempt had created, as if it were the user's (ap3e, 15-11-2026).
 */
export class DeclaredInputsRegistry {
  private readonly bySession = new Map<string, readonly string[]>();
  private readonly parents = new Map<string, string>();

  /** Declare `paths` (absolute, already resolved) for `sessionId`; replaces any earlier list. */
  declare(sessionId: string, paths: readonly string[]): void {
    const absolute = [...new Set(paths.filter((path) => isAbsolute(path)))];
    if (absolute.length === 0) {
      this.bySession.delete(sessionId);
      return;
    }
    this.bySession.set(sessionId, absolute);
  }

  /** Tie a worker session to the session that delegated it, until `clear`. */
  link(sessionId: string, parentSessionId: string): void {
    if (sessionId === parentSessionId) return;
    this.parents.set(sessionId, parentSessionId);
  }

  /** Drop a session's list and its link. Safe to call when nothing was declared. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.parents.delete(sessionId);
  }

  /** The absolute paths declared for `sessionId`; empty when none. */
  inputsOf(sessionId: string): readonly string[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** The session that delegated `sessionId`, while it runs; undefined for any other session. */
  parentOf(sessionId: string): string | undefined {
    return this.parents.get(sessionId);
  }
}
