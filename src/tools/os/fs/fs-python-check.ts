/**
 * Parse-check for the Python files `os.fs.write` / `os.fs.edit` /
 * `os.fs.patch` just changed — the `.py` counterpart of
 * `fs-parse-check.ts`, which judges JS and JSON in-process.
 *
 * k8f (16-11-2026): a worker wrote a 289-line `formel.py` whose one
 * docstring opened with two quotes instead of three. Every later
 * docstring flipped inside out, and CPython blamed line 272, the last
 * opener. The worker read the file five times and rewrote it whole:
 * about 150 s on the run's critical path. The write's own result said
 * only "wrote 9222 bytes".
 *
 * So the write result carries `compile()`'s verdict, and when that is an
 * unterminated triple-quoted string it also names the first string that
 * runs over code — the line to fix — which CPython's message does not.
 * Like the JS check it is advisory: it never blocks or alters a change,
 * says nothing about a file that compiles, and says nothing at all when
 * no Python 3 is installed or the check could not run.
 */
import { extname } from "node:path";

import {
  checkPythonFile,
  type InterpreterOptions,
} from "../../verify/check-script-syntax.js";
import {
  checkChangedFile,
  type ChangedFileCheckInput,
} from "./fs-content-check.js";
import {
  displayPath,
  formatParseWarning,
  PARSE_CHECK_MAX_CHARS,
  type ParseCheck,
} from "./fs-parse-check.js";

const SKIPPED: ParseCheck = { kind: "skipped" };

export function isPythonPath(path: string): boolean {
  return extname(path).toLowerCase() === ".py";
}

/**
 * `compile()` the file now on disk at `absolute` (`content` is what was
 * written there, for the size cap and the hint). `skipped` is "no
 * verdict": not Python, oversized, no interpreter, timed out. Never throws.
 */
export async function checkPythonParses(
  absolute: string,
  content: string,
  options: InterpreterOptions = {},
): Promise<ParseCheck> {
  if (!isPythonPath(absolute) || content.length > PARSE_CHECK_MAX_CHARS) {
    return SKIPPED;
  }
  try {
    const result = await checkPythonFile(absolute, options);
    if (result.ok !== false) return SKIPPED;
    const message = describeCompileError(result.error ?? "");
    const hint = /unterminated triple-quoted string/.test(message)
      ? formatSwallowedHint(findSwallowingString(content))
      : "";
    return { kind: "error", message: `${message}${hint}` };
  } catch {
    return SKIPPED;
  }
}

/**
 * `SyntaxError: … (line N)` from compile()'s traceback tail, which names
 * the file in a `File "…", line N` frame and ends on the error line.
 */
export function describeCompileError(stderr: string): string {
  const text = stderr.replace(/\r\n/g, "\n");
  const error = text.match(/^((?:SyntaxError|IndentationError|TabError|ValueError)\b[^\n]*)$/m)?.[1];
  if (error === undefined) return text.trim().split("\n").slice(-1)[0] ?? "SyntaxError";
  const line = [...text.matchAll(/^[ \t]*File "[^\n]*", line (\d+)/gm)].pop()?.[1];
  return line === undefined ? error : `${error} (line ${line})`;
}

/** A line that only code starts with: what a docstring does not hold. */
const CODE_LINE =
  /^[ \t]*(?:(?:async[ \t]+)?def[ \t]+[A-Za-z_]\w*[ \t]*\(|class[ \t]+[A-Za-z_]\w*[ \t]*[(:]|import[ \t]+[A-Za-z_]|from[ \t]+[\w.]+[ \t]+import\b)/;

export interface SwallowingString {
  /** 1-based line the string's opening quotes are on. */
  readonly opened: number;
  /** 1-based line of the first code line inside it. */
  readonly codeLine: number;
  readonly code: string;
}

/**
 * The first triple-quoted string whose body holds a line of code
 * (`def name(`, `class Name:`, an import), or null. A lexer just good
 * enough for that: comments, one-line strings with escapes, and triple
 * quotes. Only consulted after compile() failed, so the odd miss on an
 * exotic f-string costs a hint, never a verdict.
 */
export function findSwallowingString(source: string): SwallowingString | null {
  const text = source.replace(/\r\n?/g, "\n");
  const n = text.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const ch = text[i];
    if (ch === "\n") {
      line += 1;
      i += 1;
    } else if (ch === "#") {
      while (i < n && text[i] !== "\n") i += 1;
    } else if (ch === '"' || ch === "'") {
      const delim = ch.repeat(3);
      if (text.startsWith(delim, i)) {
        let j = i + 3;
        while (j < n && !text.startsWith(delim, j)) j += text[j] === "\\" ? 2 : 1;
        const body = text.slice(i + 3, Math.min(j, n)).split("\n");
        for (let k = 1; k < body.length; k += 1) {
          if (CODE_LINE.test(body[k] ?? "")) {
            return { opened: line, codeLine: line + k, code: (body[k] ?? "").trim() };
          }
        }
        line += body.length - 1;
        i = j + 3;
      } else {
        let j = i + 1;
        while (j < n && text[j] !== ch && text[j] !== "\n") {
          if (text[j] === "\\") {
            if (text[j + 1] === "\n") line += 1;
            j += 2;
          } else {
            j += 1;
          }
        }
        // An unclosed one-line string ends at the newline, which is left
        // for the loop so the line count stays right.
        i = text[j] === ch ? j + 1 : j;
      }
    } else {
      i += 1;
    }
  }
  return null;
}

function formatSwallowedHint(found: SwallowingString | null): string {
  if (found === null) return "";
  const code = found.code.length > 60 ? `${found.code.slice(0, 57)}...` : found.code;
  return (
    `. The string opened at line ${found.opened} runs over code (line ${found.codeLine}: \`${code}\`)` +
    ` — its quotes are the error: fix line ${found.opened} with os.fs.edit, do not rewrite the file`
  );
}

/**
 * `checkChangedFile` (JS/JSON parse and content warnings), plus the
 * compile() warning first for a `.py` file. Judged on the file after the
 * change only: compiling the old text too would cost a second process
 * on every edit for a sharper wording.
 */
export async function checkChangedSource(
  input: ChangedFileCheckInput,
  options: InterpreterOptions = {},
): Promise<string | null> {
  const rest = checkChangedFile(input);
  if (!isPythonPath(input.absolute)) return rest;
  const python = formatParseWarning({
    path: displayPath(input.absolute, input.workingDir),
    change: input.change,
    after: await checkPythonParses(input.absolute, input.after, options),
  });
  const lines = [python, rest].filter((l): l is string => l !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}
