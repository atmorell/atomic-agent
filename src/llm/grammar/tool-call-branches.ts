import { quoteGbnf } from "./reasoning-prelude.js";

/**
 * The `tool-call` rule of the static grammar and how a per-request
 * grammar narrows it. Split out of `build-grammar.ts`, which keeps the
 * per-request cache and calls `narrowToolCallRules` on a cache miss.
 */

/** The one rule a per-request grammar rewrites for the generic branch. */
const TOOL_NAME_RULE_RE = /^tool-name ::= .*$/m;

/** Terminal verb every restricted grammar keeps: a step must be able to exit. */
export const GRAMMAR_EXIT_TOOL = "reply";

/**
 * Tools whose calls have their own branch of `tool-call`, outside
 * `tool-name`, because their args have required fields the generic
 * `object` rule cannot enforce (`grammars/tool-call.gbnf`): under it
 * `{"args":{}}` is legal and small local models take that way out.
 * `os.shell.run` needs a non-empty `cmd`, `os.fs.read` a non-empty
 * `path`, `os.fs.write` a non-empty `path` and a `content` string; the
 * rest (ATO-1114) are held to their own tool's check the same way, as
 * the grammar file lists. Listed in the order the branches appear in the
 * rule.
 */
const DEDICATED_BRANCHES: ReadonlyArray<{ tool: string; rule: string }> = [
  { tool: "os.shell.run", rule: "shell-call" },
  { tool: "os.fs.read", rule: "fs-read-call" },
  { tool: "os.fs.write", rule: "fs-write-call" },
  { tool: "os.fs.edit", rule: "fs-edit-call" },
  { tool: "os.fs.move", rule: "fs-move-call" },
  { tool: "os.fs.list", rule: "fs-list-call" },
  { tool: "os.fs.grep", rule: "fs-grep-call" },
  { tool: "os.fs.glob", rule: "fs-glob-call" },
  { tool: "os.web.search", rule: "web-search-call" },
  { tool: "os.web.fetch", rule: "web-fetch-call" },
  { tool: "os.http.request", rule: "http-request-call" },
  { tool: "skill.view", rule: "skill-view-call" },
  { tool: "tool.view", rule: "tool-view-call" },
  { tool: "tool.search", rule: "tool-search-call" },
  { tool: "memory.notes.store", rule: "notes-store-call" },
  { tool: "memory.notes.recall", rule: "notes-recall-call" },
];

/**
 * The split `tool-call` rule of a grammar whose `reply` has its own branch
 * (#681): `reply-call` carries reply with the guarded text rule, then the
 * dedicated branches the grammar has, then `other-call` (the generic
 * branch over `tool-name`, which lists none of them). An older grammar
 * without the split keeps `reply` in `tool-name`; one from before a
 * dedicated branch existed simply lacks it and still narrows.
 */
const SPLIT_TOOL_CALL_RULE_RE = new RegExp(
  `^tool-call ::= reply-call((?: \\| (?:${[...DEDICATED_BRANCHES.map((b) => b.rule), "other-call"].join("|")}))*)$`,
  "m",
);

/**
 * The per-request rewrite of a base grammar's call rules for `names`
 * (sorted, deduplicated, `reply` included). A split grammar keeps `reply`
 * on its own branch, keeps each dedicated branch the base defines and the
 * request admits, and lists the other names in `tool-name`. A branch with
 * nothing to carry is dropped from `tool-call` (an empty alternation is
 * not valid GBNF); `tool-name` is then left as it was, an unreferenced
 * rule llama.cpp still parses. `work-call` gets the same branches but
 * `reply-call` (`withWorkCallRule`). A grammar without the split gets
 * every name in `tool-name`.
 */
export function narrowToolCallRules(grammar: string, names: string[]): string {
  if (!SPLIT_TOOL_CALL_RULE_RE.test(grammar)) return replaceToolNameRule(grammar, names);
  const branches = ["reply-call"];
  const carried = new Set([GRAMMAR_EXIT_TOOL]);
  for (const { tool, rule } of DEDICATED_BRANCHES) {
    if (!new RegExp(`^${rule} ::= `, "m").test(grammar)) continue;
    carried.add(tool);
    if (names.includes(tool)) branches.push(rule);
  }
  const others = names.filter((name) => !carried.has(name));
  if (others.length > 0) branches.push("other-call");
  const narrowed = withWorkCallRule(
    grammar.replace(SPLIT_TOOL_CALL_RULE_RE, `tool-call ::= ${branches.join(" | ")}`),
    branches.slice(1),
  );
  return others.length > 0 ? replaceToolNameRule(narrowed, others) : narrowed;
}

const WORK_CALL_RULE_RE = /^work-call ::= .*$/m;
const TOOL_CALL_ARRAY_RULE_RE = /^tool-call-array ::= .*$/m;
const SOLO_TOOL_CALL_ARRAY_RULE = 'tool-call-array ::= "[" ws tool-call ws "]"';

/**
 * `work-call` is every call of `tool-call-array` but the last, so
 * `reply` can only close the array, which is where the batch validator
 * wants a terminal (k8j, 16-11-2026: a refused `[reply, os.shell.run]`
 * cost a worker a repair and a turn retry, ~50 s). It carries the
 * request's branches without `reply-call`; with none left (`reply`
 * alone) the array is one call long and `work-call` goes unreferenced.
 * A grammar without the rule (an older file) is returned as it was.
 */
function withWorkCallRule(grammar: string, workBranches: string[]): string {
  if (!WORK_CALL_RULE_RE.test(grammar)) return grammar;
  return workBranches.length > 0
    ? grammar.replace(WORK_CALL_RULE_RE, `work-call ::= ${workBranches.join(" | ")}`)
    : grammar.replace(TOOL_CALL_ARRAY_RULE_RE, SOLO_TOOL_CALL_ARRAY_RULE);
}

function replaceToolNameRule(grammar: string, names: string[]): string {
  const rule = `tool-name ::= ${names.map(quoteToolNameLiteral).join(" | ")}`;
  return TOOL_NAME_RULE_RE.test(grammar)
    ? grammar.replace(TOOL_NAME_RULE_RE, rule)
    : // A base without the rule (an older grammar file): a later
      // definition wins in GBNF, so appending still restricts.
      `${grammar.trimEnd()}\n${rule}\n`;
}

/**
 * The tool names a grammar admits when its `tool-name` rule is a flat
 * alternation of literals (the shape `buildGrammarForTools` writes),
 * sorted, with `reply` and every dedicated branch the `tool-call` rule
 * lists included. `null` for the static base grammar, whose rule is
 * composed of sub-rules. A test helper more than a runtime one.
 */
export function grammarToolNames(grammar: string): string[] | null {
  const split = grammar.match(SPLIT_TOOL_CALL_RULE_RE);
  const branches = split ? split[1]!.split(" | ").filter((b) => b.length > 0) : null;
  const names: string[] = [];
  if (branches === null || branches.includes("other-call")) {
    const match = grammar.match(TOOL_NAME_RULE_RE);
    if (!match) return null;
    const body = match[0].slice("tool-name ::= ".length);
    for (const alt of body.split("|")) {
      const literal = alt.trim().match(/^"\\"(.*)\\""$/);
      if (!literal) return null;
      names.push(literal[1]!);
    }
  }
  if (branches !== null) {
    names.push(GRAMMAR_EXIT_TOOL);
    for (const { tool, rule } of DEDICATED_BRANCHES) {
      if (branches.includes(rule)) names.push(tool);
    }
  }
  return Array.from(new Set(names)).sort();
}

/** `os.fs.read` → `"\"os.fs.read\""` — a JSON string literal inside a GBNF one. */
function quoteToolNameLiteral(name: string): string {
  return quoteGbnf(`"${name}"`);
}

const FS_WRITE_ARGS_RULE_RE = /^fs-write-args ::= .*$/m;

/**
 * The `os.fs.write` branch held to `paths` (greb K): the `path` value of
 * `fs-write-args` becomes `fs-write-path`, a flat alternation over the
 * JSON spellings of `paths`, so a fusion worker cannot emit a whole-file
 * rewrite of a file it already wrote — it changes those with
 * `os.fs.edit`. The free `pair` tail can still repeat `path`, so the
 * batch gate holds the same set at dispatch (`writeScopeAdmits`).
 * Empty `paths`, or a grammar without the rule (an older file, or one
 * whose `path` is not a `required-string`), is returned as it was.
 */
export function withWritePaths(grammar: string, paths: readonly string[]): string {
  if (paths.length === 0) return grammar;
  const line = grammar.match(FS_WRITE_ARGS_RULE_RE)?.[0];
  if (line === undefined || !line.includes("required-string")) return grammar;
  const scoped = line.replace("required-string", "fs-write-path");
  const rule = String.raw`fs-write-path ::= "\"" ( ${paths.map(quoteWritePathLiteral).join(" | ")} ) "\""`;
  // A function replacer: a path may hold `$`, which a string one expands.
  return grammar.replace(FS_WRITE_ARGS_RULE_RE, () => `${scoped}\n${rule}`);
}

/** `C:\a.py` → the GBNF literal of its JSON string body, `C:\\a.py`. */
function quoteWritePathLiteral(path: string): string {
  return quoteGbnf(JSON.stringify(path).slice(1, -1));
}
