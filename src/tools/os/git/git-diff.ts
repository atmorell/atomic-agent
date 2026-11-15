import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Untracked files shown in one working-tree diff; the rest are counted. */
const MAX_UNTRACKED_FILES = 50;

export const osGitDiffTool: ToolDefinition = {
  name: "os.git.diff",
  description:
    "Show a unified diff. Args (all optional): revisionRange (e.g. 'HEAD~3..HEAD' or single 'HEAD~1'), staged (bool — --cached), paths (array of path filters), context (lines of context, default 3). The working-tree diff also lists untracked files as new files. Read-only.",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    const revisionRange =
      typeof rawArgs.revisionRange === "string" &&
      rawArgs.revisionRange.length > 0
        ? rawArgs.revisionRange
        : undefined;
    const staged = rawArgs.staged === true;
    const context = parseContext(rawArgs.context, 3);
    const paths = parsePaths(rawArgs.paths);

    const args: string[] = ["diff", `--unified=${context}`];
    if (staged) args.push("--cached");
    if (revisionRange) args.push(revisionRange);
    if (paths.length > 0) {
      args.push("--");
      args.push(...paths);
    }

    const result = await runGit({
      repo,
      workingDir: ctx.workingDir,
      args,
      signal: ctx.signal,
      timeoutMs: 30_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    requireGitSuccess("os.git.diff", result);

    // A working-tree diff also shows untracked files as new-file diffs: a
    // review of fresh work (every file still `??`) must see the code, not
    // "(no diff)". Staged and revision diffs keep plain git semantics.
    const untracked =
      !staged && !revisionRange
        ? await diffUntracked({
            repo,
            workingDir: ctx.workingDir,
            signal: ctx.signal,
            context,
            paths,
            budgetBytes: MAX_OUTPUT_BYTES - result.stdout.length,
          })
        : { text: "", files: 0, binary: 0, omitted: 0, truncated: false };

    const output = result.stdout + untracked.text;
    const stats = countAddRemove(output);
    const empty = output.trim().length === 0;

    return compressToolResult(
      {
        tool: "os.git.diff",
        status: "ok",
        output: empty ? "(no diff)" : output,
        details: {
          empty,
          added: stats.added,
          removed: stats.removed,
          truncated: result.truncated || untracked.truncated,
          repoRoot: result.repoRoot,
          revisionRange: revisionRange ?? null,
          staged,
          paths,
          untracked: untracked.files,
          untrackedBinary: untracked.binary,
          untrackedOmitted: untracked.omitted,
        },
      },
      { maxSummaryLength: 64 * 1024, maxTailLines: 4000 },
    );
  },
};

async function diffUntracked(options: {
  repo: string | undefined;
  workingDir: string;
  signal: AbortSignal;
  context: number;
  paths: string[];
  budgetBytes: number;
}): Promise<{ text: string; files: number; binary: number; omitted: number; truncated: boolean }> {
  const none = { text: "", files: 0, binary: 0, omitted: 0, truncated: false };
  const listArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
  if (options.paths.length > 0) listArgs.push("--", ...options.paths);
  const listed = await runGit({
    repo: options.repo,
    workingDir: options.workingDir,
    args: listArgs,
    signal: options.signal,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (listed.exitCode !== 0) return none;
  const files = listed.stdout.split("\0").filter((f) => f.length > 0);
  if (files.length === 0) return none;

  let text = "";
  let shown = 0;
  let binary = 0;
  let considered = 0;
  let truncated = false;
  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    if (options.signal.aborted) break;
    const remaining = options.budgetBytes - text.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const one = await runGit({
      repo: options.repo,
      workingDir: options.workingDir,
      args: ["diff", "--no-index", `--unified=${options.context}`, "--", "/dev/null", file],
      signal: options.signal,
      timeoutMs: 30_000,
      maxOutputBytes: remaining,
    });
    considered++;
    // --no-index exits 1 when the files differ, which is the expected case.
    if (one.exitCode !== 0 && one.exitCode !== 1) continue;
    // Binary files (compiled caches such as __pycache__/*.pyc) carry no code
    // to review; listing them made the orchestrator delegate a cleanup
    // (ap1c, 15-11-2026). git status still shows them.
    if (BINARY_DIFF.test(one.stdout)) {
      binary++;
      continue;
    }
    text += one.stdout.endsWith("\n") || one.stdout.length === 0 ? one.stdout : `${one.stdout}\n`;
    shown++;
    if (one.truncated) {
      truncated = true;
      break;
    }
  }
  const omitted = files.length - considered;
  if (omitted > 0) text += `(${omitted} more untracked file(s) not shown; pass paths to see them)\n`;
  return { text, files: shown, binary, omitted, truncated };
}

const BINARY_DIFF = /^Binary files .* differ$/m;

function parseContext(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error("os.git.diff: `context` must be a non-negative number");
  }
  return Math.floor(raw);
}

function parsePaths(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("os.git.diff: `paths` must be an array of strings");
  }
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("os.git.diff: `paths` entries must be non-empty strings");
    }
    out.push(p);
  }
  return out;
}

function countAddRemove(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
