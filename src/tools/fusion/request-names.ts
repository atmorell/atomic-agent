import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The runtime's check of the request's own names against what a worker
 * wrote. A name the request fixes as a call (`gem(opgaver)`) is a contract:
 * spelled one letter off, the function does not exist and every caller
 * and test fails. A local worker did exactly that three runs in a row
 * (`Lager.sem` for the request's `gem`, 15-11-2026); the exact-spelling
 * rule in the brief did not stop it, and only the judge — a paid call
 * and a full re-run later — caught it. This check is plain code: after a
 * step that wrote files it compares the worker's definitions and calls
 * with the request's names, and a near miss becomes one steer the worker
 * reads at its next step boundary.
 *
 * It flags a near miss only when all of these hold, so a worker that
 * merely does not touch a name is never told to:
 * - the request writes `R(` (R at least three characters);
 * - the worker's files define or call N (`def N(`, `class N`,
 *   `function N(`, `.N(`), N the same length as R and one character off;
 * - N is not a word anywhere in the request, nor a common library name;
 * - no written file calls or defines R (a comment or string saying "gem"
 *   does not count: the worker can describe the name and still not use it).
 */

/** One request name the worker's files spell one character off. */
export interface NameMiss {
  /** The request's spelling. */
  expected: string;
  /** The worker's spelling. */
  found: string;
  /** The first written file that uses the worker's spelling. */
  file: string;
}

export interface WrittenText {
  path: string;
  text: string;
}

/** Names the request writes as calls: `gem(opgaver)`, `til_dict()`. */
const REQUEST_CALL = /(?<![\p{L}\p{N}_])([A-Za-z_][A-Za-z0-9_]{2,})\(/gu;
const REQUEST_WORD = /[\p{L}\p{N}_]+/gu;
/** Where a worker's code defines a name or calls it as a method. */
const CODE_NAME =
  /(?:\bdef\s+|\bclass\s+|\bfunction\s+|\.)([A-Za-z_][A-Za-z0-9_]{2,})\b(?=\s*[(:])/g;
/** Any use of a name as a call or a definition: what makes R present. */
const CALLED = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const CLASS_DEF = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Library and builtin names that sit one letter from a plausible request
 * name (`get` from `gem`, `set` from `sat`): a worker calling `d.get(`
 * in a file that has no business with `gem` must not be steered.
 */
const COMMON_NAMES: ReadonlySet<string> = new Set([
  "add", "all", "any", "get", "set", "pop", "put", "run", "sum", "min", "max",
  "len", "map", "zip", "int", "str", "abs", "dir", "end", "new", "now", "sub",
  "keys", "copy", "join", "find", "read", "load", "dump", "open", "send",
  "sort", "list", "dict", "next", "iter", "seek", "tell", "walk", "exit",
  "main", "test", "mock", "call", "exec", "eval", "stat", "path", "name",
  "items", "close", "write", "parse", "split", "strip", "lower", "upper",
  "match", "today", "index", "count", "clear", "range", "print", "input",
  "start", "sleep", "dumps", "loads", "mkdir", "touch", "chdir", "rmdir",
  "insert", "remove", "update", "values", "append", "extend", "search",
  "sorted", "filter", "format", "exists", "unlink", "rename", "raises",
  "fixture", "replace", "isoformat", "strftime", "strptime",
]);

/** The cap on what one check reads, per file and in files. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 64;

/** The request's call names, in first-seen order. */
export function requestCallNames(request: string): string[] {
  const seen = new Set<string>();
  for (const match of request.matchAll(REQUEST_CALL)) seen.add(match[1]!);
  return [...seen];
}

function oneCharOff(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let differences = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      differences += 1;
      if (differences > 1) return false;
    }
  }
  return true;
}

/**
 * The request's names the worker's written files spell one character
 * off, by the rules in the module comment. One entry per (expected,
 * found) pair, in request order.
 */
export function findNameMisses(
  request: string,
  files: readonly WrittenText[],
): NameMiss[] {
  const expectedNames = requestCallNames(request);
  if (expectedNames.length === 0 || files.length === 0) return [];
  const requestWords = new Set(request.match(REQUEST_WORD) ?? []);
  // Every name the worker's files call or define: a request name among
  // them is present, however the rest of the files spell things.
  const usedNames = new Set<string>();
  // Each name the worker defines or calls as a method, with the first
  // file using it: the candidates for a near miss.
  const codeNames = new Map<string, string>();
  for (const file of files) {
    for (const match of file.text.matchAll(CALLED)) usedNames.add(match[1]!);
    for (const match of file.text.matchAll(CLASS_DEF)) usedNames.add(match[1]!);
    for (const match of file.text.matchAll(CODE_NAME)) {
      const name = match[1]!;
      if (!codeNames.has(name)) codeNames.set(name, file.path);
    }
  }
  const misses: NameMiss[] = [];
  for (const expected of expectedNames) {
    if (usedNames.has(expected)) continue;
    for (const [found, file] of codeNames) {
      if (requestWords.has(found) || COMMON_NAMES.has(found)) continue;
      if (oneCharOff(expected, found)) misses.push({ expected, found, file });
    }
  }
  return misses;
}

/** The steer a worker reads at its next step boundary. */
export function formatNameSteer(misses: readonly NameMiss[]): string {
  const lines = misses.map(
    (m) =>
      `- the request names \`${m.expected}(\`, but none of your files define or call \`${m.expected}\`; ` +
      `you wrote \`${m.found}\` (one letter off, in ${m.file}).`,
  );
  return [
    "Name check by the runtime:",
    ...lines,
    "If that is the same function, rename it everywhere — definitions, calls and tests — " +
      "spelled exactly as the request spells it, then re-run the tests. If it is a different function, leave it.",
  ].join("\n");
}

/**
 * The text of the files a worker wrote, resolved against its working
 * folder. A file that is gone, unreadable or over the size cap is
 * skipped: the check then sees less, never something wrong.
 */
export function readWrittenFiles(
  paths: readonly string[],
  workingDir: string,
): WrittenText[] {
  const out: WrittenText[] = [];
  for (const path of paths.slice(0, MAX_FILES)) {
    const absolute = resolve(workingDir, path);
    try {
      if (statSync(absolute).size > MAX_FILE_BYTES) continue;
      out.push({ path, text: readFileSync(absolute, "utf8") });
    } catch {
      // Gone or unreadable: nothing to compare.
    }
  }
  return out;
}
