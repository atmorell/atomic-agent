import { isAbsolute, normalize, sep } from "node:path";

/** One `owners` entry as compared: `owner` null marks the session's own path. */
interface OwnerEntry {
  key: string;
  owner: string | null;
}

/** A path as owners are compared: normalised, no trailing separator, lower case on Windows. */
function ownerKey(path: string): string {
  let key = normalize(path);
  while (key.length > 1 && key.endsWith(sep) && !/^[A-Za-z]:\\$/.test(key)) {
    key = key.slice(0, -1);
  }
  return process.platform === "win32" ? key.toLowerCase() : key;
}

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
 *
 * `declareForeign` holds the contract's `owners` the same way: the paths
 * another task of the fan-out owns, which this worker's file tools
 * refuse (`fs-owner-guard.ts`). Live (k8e, 16-11-2026) the core worker
 * wrote the CLI worker's `__main__.py` and then a test file to drive its
 * own code; the judge read both as strays and sent it back, and the
 * retry ran out the clock.
 */
export class DeclaredInputsRegistry {
  private readonly bySession = new Map<string, readonly string[]>();
  private readonly parents = new Map<string, string>();
  private readonly owners = new Map<string, readonly OwnerEntry[]>();

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

  /**
   * Declare the paths (absolute, already resolved) another task owns,
   * each with that task's id; replaces any earlier declaration. `own`
   * are the paths this session's task owns: the most specific entry
   * decides, so a file a task owns inside a folder another task owns
   * stays its own.
   */
  declareForeign(
    sessionId: string,
    foreign: ReadonlyMap<string, string>,
    own: readonly string[] = [],
  ): void {
    const entries: OwnerEntry[] = [];
    for (const [path, owner] of foreign) {
      if (isAbsolute(path)) entries.push({ key: ownerKey(path), owner });
    }
    if (entries.length === 0) {
      this.owners.delete(sessionId);
      return;
    }
    for (const path of own) {
      if (isAbsolute(path)) entries.push({ key: ownerKey(path), owner: null });
    }
    entries.sort((a, b) => b.key.length - a.key.length);
    this.owners.set(sessionId, entries);
  }

  /** Drop a session's list, its owners and its link. Safe to call when nothing was declared. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.parents.delete(sessionId);
    this.owners.delete(sessionId);
  }

  /**
   * The task that owns `path` (absolute) when it is not `sessionId`'s
   * own — the path itself or a folder it sits in; undefined otherwise.
   * Case-insensitive on Windows, as the filesystem is.
   */
  foreignOwnerOf(sessionId: string, path: string): string | undefined {
    const entries = this.owners.get(sessionId);
    if (entries === undefined || !isAbsolute(path)) return undefined;
    const key = ownerKey(path);
    const hit = entries.find(
      (entry) => key === entry.key || key.startsWith(entry.key + sep),
    );
    return hit?.owner ?? undefined;
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
