import { resolveUserPath } from "../os/expand-home.js";

/**
 * The contract's `inputs` (F51): the files the operator provided, which
 * every worker of the fan-out may read and edit in place but never
 * replace.
 *
 * Layer 1 of the same fix refuses an `os.fs.write` over a file the
 * request names, lifted only by the user's own words (since ATO-851
 * `overwrite: true` no longer lifts it either). A worker is the wrong
 * party to read those words: it sees the request only as context,
 * and the orchestrator is the one that read the whole job. So the
 * orchestrator declares the inputs once, the block every worker reads
 * lists them under "read and edit in place, never replace", and a
 * worker's `os.fs.write` to one is refused with no `overwrite`
 * exemption — the orchestrator can redeclare. Paths are relative to the
 * working directory (or absolute); a glob is listed for the workers as
 * written but guards nothing, since a write has one path.
 */

export const MAX_CONTRACT_INPUTS = 32;

/** Globs are patterns, not paths: a write to one is not a thing. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * `contract.inputs` from the wire: every bad entry is named by index
 * and skipped, the rest carry (F44 — one refusal names every problem;
 * a fan-out is not held up over one entry). Trimmed and deduplicated.
 */
export function readContractInputs(
  value: unknown,
  problems: string[],
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    problems.push("contract.inputs must be an array of paths");
    return undefined;
  }
  if (value.length > MAX_CONTRACT_INPUTS) {
    problems.push(
      `contract.inputs has ${value.length} entries; at most ${MAX_CONTRACT_INPUTS}`,
    );
    return undefined;
  }
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    const path = typeof entry === "string" ? entry.trim() : "";
    if (path.length === 0) {
      problems.push(`contract.inputs[${i}] must be a non-empty path`);
      continue;
    }
    if (!out.includes(path)) out.push(path);
  }
  return out.length > 0 ? out : undefined;
}

/** The INPUTS section of the shared contract block; nothing when none are declared. */
export function renderContractInputs(
  inputs: readonly string[] | undefined,
): string[] {
  if (inputs === undefined || inputs.length === 0) return [];
  return [
    `INPUTS (the operator's own files — read and edit in place, never replace; os.fs.write on one is refused):`,
    ...inputs.map((path) => `- ${path}`),
  ];
}

/** The id prefix of autoverify's repair worker (`autoverify.ts`): it repairs across owners. */
const AUTOVERIFY_REPAIR_PREFIX = "autoverify-repair-";

/**
 * The contract's `owners` for one task, as its worker's tools will spell
 * the paths (k8e): `foreign` maps each path another task owns to that
 * task's id, `own` lists the paths this task owns — the task itself, or
 * the task it was split from (`parent/child` ids). `null` when nothing is
 * foreign, so no guard is armed: no contract, no owners, a task that owns
 * them all, or autoverify's repair worker. Globs and unresolvable entries
 * are left out, as for inputs.
 */
export function resolveContractOwners(
  owners: Readonly<Record<string, string>> | undefined,
  taskId: string,
  workingDir: string,
): { foreign: Map<string, string>; own: string[] } | null {
  if (owners === undefined || taskId.startsWith(AUTOVERIFY_REPAIR_PREFIX)) {
    return null;
  }
  const foreign = new Map<string, string>();
  const own: string[] = [];
  for (const [path, owner] of Object.entries(owners)) {
    if (GLOB_CHARS.test(path)) continue;
    let absolute: string;
    try {
      absolute = resolveUserPath(path, workingDir);
    } catch {
      continue;
    }
    if (owner === taskId || taskId.startsWith(`${owner}/`)) own.push(absolute);
    else foreign.set(absolute, owner);
  }
  return foreign.size === 0 ? null : { foreign, own };
}

/**
 * The declared inputs as the worker's tools will spell them: absolute,
 * resolved against `workingDir` the way `resolveUserPath` resolves a
 * tool's `path`. Globs and unresolvable entries are left out; they
 * guard nothing.
 */
export function resolveContractInputs(
  inputs: readonly string[],
  workingDir: string,
): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (GLOB_CHARS.test(input)) continue;
    try {
      const absolute = resolveUserPath(input, workingDir);
      if (!out.includes(absolute)) out.push(absolute);
    } catch {
      // A path the tools could not resolve is one they could not write.
    }
  }
  return out;
}
