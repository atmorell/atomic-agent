import { isAbsolute, relative, sep } from "node:path";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import type { ToolContext } from "../../tool-registry.js";
import type { DeclaredInputsRegistry } from "./fs-declared-inputs.js";

/**
 * The refusal in front of every file tool that changes a path the
 * fan-out's contract gives another task (`owners`, declared per worker
 * session by `armWorkerSession` — `fs-declared-inputs.ts`).
 *
 * The contract said "nobody else writes there", and only the prompt said
 * it. Live (k8e, 16-11-2026) the core worker wrote the CLI worker's
 * `__main__.py` within its first step, and later a test file to drive
 * its own code; the judge read both as work outside its task and sent it
 * back, and the retry ran out the ten-minute clock. So `os.fs.write`,
 * `os.fs.edit`, `os.fs.patch`, `os.fs.move` (either end) and
 * `os.fs.restore` refuse such a path before the approval prompt, with no
 * `overwrite` exemption, and the refusal tells the worker to build
 * against the contract's names and say what it needed — a stand-in
 * written under another name is the same stray. A dry-run patch writes
 * nothing and is not refused. A shell redirect is not a file tool and is
 * not covered (`src/tools/fusion/README.md`).
 */

/** What the file tools need: the lookup, optional so embedders and tests may omit it. */
export type ForeignOwners = Partial<Pick<DeclaredInputsRegistry, "foreignOwnerOf">>;

export interface ForeignOwnerRefusal {
  owner: string;
  /** The absolute path refused. */
  path: string;
  /** The path as the worker reads it: relative to its working directory when inside it. */
  display: string;
  text: string;
}

/** The first of `absolutes` another task owns, as a refusal; `null` when none is. */
export function checkForeignOwner(
  registry: ForeignOwners | undefined,
  ctx: Pick<ToolContext, "sessionId" | "workingDir">,
  absolutes: readonly string[],
): ForeignOwnerRefusal | null {
  const lookup = registry?.foreignOwnerOf;
  if (lookup === undefined) return null;
  for (const path of absolutes) {
    const owner = lookup.call(registry, ctx.sessionId, path);
    if (owner === undefined) continue;
    const display = displayPath(path, ctx.workingDir);
    return {
      owner,
      path,
      display,
      text: `refused: ${display} belongs to task "${owner}" in this fan-out's contract; only that task writes it. Nothing was written. Do not retry this path or write the content elsewhere — build against the names the CONTRACT gives and say in your reply what you needed from ${display}.`,
    };
  }
  return null;
}

/**
 * Bound for the compressed refusal: 236 characters of fixed wording,
 * the path twice and the task id. A path outside the working directory
 * is shown absolute, so the bound is two PATH_MAX-sized paths and room.
 */
export const OWNER_REFUSAL_SUMMARY_CHARS = 2400;

/** The tool result a refused call returns instead of running. */
export function refuseForeignOwnerWrite(
  tool: string,
  refused: ForeignOwnerRefusal,
): CompressedToolResult {
  return compressToolResult(
    {
      tool,
      status: "error",
      output: refused.text,
      details: {
        refused: "owner",
        owner: refused.owner,
        path: refused.path,
        display: refused.display,
      },
    },
    { maxSummaryLength: OWNER_REFUSAL_SUMMARY_CHARS },
  );
}

function displayPath(path: string, workingDir: string): string {
  const rel = relative(workingDir, path);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}
