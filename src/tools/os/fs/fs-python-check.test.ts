import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CheckerRun, CheckerRunner } from "../../verify/check-script-syntax.js";
import {
  checkChangedSource,
  checkPythonParses,
  describeCompileError,
  findSwallowingString,
} from "./fs-python-check.js";

/** k8f's formel.py, trimmed: line 7 opens its docstring with two quotes. */
const K8F_BROKEN = [
  '"""Formel-parsing."""', // 1
  "", // 2
  "import re", // 3
  "", // 4
  "", // 5
  "def _kolonne_til_nr(bogstav):", // 6
  "    \"\"'A' -> 1, 'B' -> 2, ..., 'Z' -> 26.\"\"\"", // 7
  "    return ord(bogstav) - ord('A') + 1", // 8
  "", // 9
  "", // 10
  "def _nr_til_kolonne(n):", // 11
  '    """1 -> \'A\', 2 -> \'B\', ..., 26 -> \'Z\'."""', // 12
  "    return chr(ord('A') + n - 1)", // 13
  "", // 14
  "", // 15
  "def _indsamle_refs(node, refs):", // 16
  '    """Rekursivt indsamler alle celle-referencer."""', // 17
  "    return refs", // 18
  "",
].join("\n");

const K8F_STDERR = [
  '  File "C:\\w\\ark\\formel.py", line 17',
  '    """Rekursivt indsamler alle celle-referencer."""',
  "                                                  ^",
  "SyntaxError: unterminated triple-quoted string literal (detected at line 19)",
].join("\n");

describe("findSwallowingString", () => {
  it("names the k8f docstring with two opening quotes, not the line CPython blames", () => {
    expect(findSwallowingString(K8F_BROKEN)).toEqual({
      opened: 7,
      codeLine: 11,
      code: "def _nr_til_kolonne(n):",
    });
  });

  it("finds nothing in a file whose strings hold no code", () => {
    const fixed = K8F_BROKEN.replace("\"\"'A'", "\"\"\"'A'");
    expect(findSwallowingString(fixed)).toBeNull();
  });

  it("ignores quotes in comments and escaped quotes in one-line strings", () => {
    const source = [
      "# a stray \"\"\" in a comment",
      "s = 'it\\'s \"\"\" fine'",
      "def f():",
      '    """Doc."""',
      "    return s",
    ].join("\n");
    expect(findSwallowingString(source)).toBeNull();
  });

  it("counts lines across a backslash-continued string and CRLF", () => {
    const source = ['x = "a\\', 'b"', '"""', "def g(x):", '"""', ""].join("\r\n");
    expect(findSwallowingString(source)).toEqual({ opened: 3, codeLine: 4, code: "def g(x):" });
  });
});

describe("describeCompileError", () => {
  it("keeps the error line and the frame's line number", () => {
    expect(describeCompileError(K8F_STDERR)).toBe(
      "SyntaxError: unterminated triple-quoted string literal (detected at line 19) (line 17)",
    );
  });
});

/** python answers the probe with "3" and the compile with `compile`. */
function fakePython(compile: Partial<CheckerRun>): CheckerRunner {
  return async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    if (!line.startsWith("python ")) {
      return { exitCode: null, stdout: "", stderr: "spawn ENOENT", missing: true, timedOut: false };
    }
    if (line.includes("sys.version_info")) {
      return { exitCode: 0, stdout: "3", stderr: "", missing: false, timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", missing: false, timedOut: false, ...compile };
  };
}

describe("checkPythonParses", () => {
  it("adds the line to fix when the string is unterminated", async () => {
    const run = fakePython({ exitCode: 1, stderr: K8F_STDERR });
    const out = await checkPythonParses("/w/ark/formel.py", K8F_BROKEN, { run, platform: "linux" });
    expect(out.kind).toBe("error");
    expect(out.kind === "error" ? out.message : "").toBe(
      "SyntaxError: unterminated triple-quoted string literal (detected at line 19) (line 17)" +
        ". The string opened at line 7 runs over code (line 11: `def _nr_til_kolonne(n):`)" +
        " — its quotes are the error: fix line 7 with os.fs.edit, do not rewrite the file",
    );
  });

  it("is silent when the file compiles, Python is missing, or the file is not .py", async () => {
    const ok = fakePython({ exitCode: 0 });
    expect(await checkPythonParses("/w/a.py", "x = 1\n", { run: ok, platform: "linux" })).toEqual({ kind: "skipped" });
    const none: CheckerRunner = async () => ({
      exitCode: null, stdout: "", stderr: "spawn ENOENT", missing: true, timedOut: false,
    });
    expect(await checkPythonParses("/w/a.py", K8F_BROKEN, { run: none, platform: "linux" })).toEqual({ kind: "skipped" });
    const bad = fakePython({ exitCode: 1, stderr: K8F_STDERR });
    expect(await checkPythonParses("/w/a.txt", K8F_BROKEN, { run: bad, platform: "linux" })).toEqual({ kind: "skipped" });
  });
});

describe("checkChangedSource with a real Python", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-python-check-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("warns on the k8f file and says nothing once it is fixed", async () => {
    const path = join(dir, "formel.py");
    await writeFile(path, K8F_BROKEN, "utf8");
    const probe = await checkPythonParses(path, K8F_BROKEN);
    if (probe.kind === "skipped") return; // no Python 3 on this machine
    const warning = await checkChangedSource({
      absolute: path,
      workingDir: dir,
      change: "write",
      after: K8F_BROKEN,
    });
    expect(warning).toMatch(/^⚠ formel\.py does not parse: SyntaxError: unterminated triple-quoted string/);
    expect(warning).toContain("fix line 7 with os.fs.edit");

    const fixed = K8F_BROKEN.replace("\"\"'A'", "\"\"\"'A'");
    await writeFile(path, fixed, "utf8");
    expect(
      await checkChangedSource({ absolute: path, workingDir: dir, change: "edit", before: K8F_BROKEN, after: fixed }),
    ).toBeNull();
  });
});
