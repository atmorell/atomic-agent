import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderContractInputs,
  resolveContractInputs,
  strayWrites,
} from "./contract-inputs.js";
import {
  contractWarnings,
  MAX_CONTRACT_RENDERED_CHARS,
  ownedPaths,
  provideSearchPaths,
  renderContractBlock,
  renderContractForTask,
  uncheckableProvides,
  unprovidedRequires,
  type DelegateContract,
} from "./contract.js";

const CONTRACT: DelegateContract = {
  owners: { "js/ship.js": "ship", "index.html": "html", "js/main.js": "main" },
  provides: [
    { task: "ship", kind: "symbol", name: "HD.Ship", in: "js/ship.js" },
    { task: "html", kind: "id", name: "btn-launch", in: "index.html" },
    { task: "ship", kind: "file", name: "js/hud.js" },
  ],
  requires: [
    { task: "main", name: "HD.Ship" },
    { task: "main", name: "btn-launch" },
  ],
  checks: [
    { task: "main", kind: "page", path: "index.html", checks: ["no errors"] },
    { kind: "command", cmd: "node", args: ["--check", "js/main.js"] },
  ],
};

describe("renderContractBlock", () => {
  it("renders every section, each entry tagged with its task", () => {
    const block = renderContractBlock(CONTRACT);
    expect(block.split("\n")[0]).toMatch(/^CONTRACT — the interface between the parts/);
    expect(block).toContain("OWNERS (path → task; write only in paths you own):");
    expect(block).toContain("- js/ship.js → ship");
    expect(block).toContain("PROVIDES:");
    expect(block).toContain("- [ship] symbol HD.Ship in js/ship.js");
    expect(block).toContain("- [html] id btn-launch in index.html");
    expect(block).toContain("- [ship] file js/hud.js");
    expect(block).toContain("REQUIRES:");
    // Grouped per task, so a worker reads one line for its dependencies.
    expect(block).toContain("- [main] HD.Ship, btn-launch");
    expect(block).toContain("CHECKS (run after the fan-out; a failing check fails its task):");
    expect(block).toContain(
      '- [main] {"kind":"page","path":"index.html","checks":["no errors"]}',
    );
    // A call-level check has no tag; its `task` key is not part of the spec.
    expect(block).toContain('- {"kind":"command","cmd":"node","args":["--check","js/main.js"]}');
    expect(block).not.toContain('"task"');
  });

  it("omits sections the contract does not declare", () => {
    const block = renderContractBlock({
      provides: [{ task: "a", kind: "file", name: "x.txt" }],
    });
    expect(block).toContain("PROVIDES:");
    expect(block).not.toContain("OWNERS");
    expect(block).not.toContain("REQUIRES");
    expect(block).not.toContain("CHECKS");
  });

  it("clips one check's JSON so a huge spec cannot eat the block", () => {
    const block = renderContractBlock({
      checks: [{ kind: "command", cmd: "x".repeat(2000) }],
    });
    expect(block.length).toBeLessThan(MAX_CONTRACT_RENDERED_CHARS);
    expect(block).toContain("…");
  });
});

describe("renderContractForTask", () => {
  it("says what this task owns, provides and may rely on, resolving each require to its source", () => {
    const main = renderContractForTask(CONTRACT, "main");
    expect(main.split("\n")).toEqual([
      "You own: js/main.js",
      "You provide: nothing listed",
      "You may rely on: HD.Ship (symbol from ship in js/ship.js) — written at the same time, so it may not exist yet: code against it, do not wait for it or read it; btn-launch (id from html in index.html) — written at the same time, so it may not exist yet: code against it, do not wait for it or read it",
    ]);
    const ship = renderContractForTask(CONTRACT, "ship");
    expect(ship).toContain("You own: js/ship.js");
    expect(ship).toContain("You provide: symbol HD.Ship in js/ship.js; file js/hud.js");
    expect(ship).toContain("You may rely on: nothing from the other parts");
  });

  it("tells a task that owns nothing to stay inside its TASK's files", () => {
    const lines = renderContractForTask(CONTRACT, "nobody");
    expect(lines).toContain(
      "You own: no path in this contract — write only the files your TASK names",
    );
  });

  it("lists owned paths in declaration order", () => {
    expect(
      ownedPaths({ owners: { b: "t", a: "t", c: "u" } }, "t"),
    ).toEqual(["b", "a"]);
  });
});

describe("contract warnings", () => {
  // What a live Gemma 4 31B orchestrator wrote: a require nothing
  // provides, and a provide with nowhere to be looked for. Each was a
  // refusal costing minutes; both are notes now.
  const LOOSE: DelegateContract = {
    provides: [
      { task: "html", kind: "id", name: "btn-launch", in: "index.html" },
      { task: "organize", kind: "other", name: "done" },
    ],
    requires: [
      { task: "main", name: "btn-launch" },
      { task: "index", name: "organized_files" },
    ],
  };
  const TASKS = [{ id: "html" }, { id: "organize" }, { id: "main" }, { id: "index" }];
  const PROVIDE_NOTE =
    'provides "done" (task organize) cannot be checked: no `in`, no owned path, no declared files';
  const REQUIRE_NOTE =
    'requires "organized_files" (task index) has no provider — nothing produces it';

  it("names the uncheckable provide and the unprovided require, in that order", () => {
    expect(uncheckableProvides(LOOSE, TASKS)).toEqual([LOOSE.provides![1]]);
    expect(unprovidedRequires(LOOSE)).toEqual([LOOSE.requires![1]]);
    expect(contractWarnings(LOOSE, TASKS)).toEqual([PROVIDE_NOTE, REQUIRE_NOTE]);
    expect(contractWarnings(CONTRACT, [])).toEqual([]);
  });

  it("looks for a provide in `in`, else the owned paths, else the declared files — never a glob", () => {
    const provide = { task: "t", kind: "symbol" as const, name: "X" };
    expect(provideSearchPaths({ ...provide, in: "a.js" }, { owners: { "b.js": "t" } }, { id: "t", files: ["c.js"] })).toEqual(["a.js"]);
    expect(provideSearchPaths(provide, { owners: { "b.js": "t", "js/**": "t" } }, { id: "t", files: ["c.js"] })).toEqual(["b.js"]);
    expect(provideSearchPaths(provide, {}, { id: "t", files: ["c.js", "d/*.js"] })).toEqual(["c.js"]);
    expect(provideSearchPaths(provide, { owners: { "js/**": "t" } }, { id: "t", files: ["d/*.js"] })).toEqual([]);
    expect(provideSearchPaths(provide, {}, undefined)).toEqual([]);
    // A file provide is its own path and is never uncheckable.
    expect(uncheckableProvides({ provides: [{ task: "t", kind: "file", name: "x.txt" }] }, [])).toEqual([]);
  });

  it("the block keeps the uncheckable provide as declared, drops the unprovided require from REQUIRES and appends both notes", () => {
    const block = renderContractBlock({ ...LOOSE, warnings: contractWarnings(LOOSE, TASKS) });
    expect(block).toContain("- [organize] other done");
    expect(block).toContain("REQUIRES:\n- [main] btn-launch\n");
    expect(block).not.toContain("- [index] organized_files");
    expect(block.split("\n").slice(-2)).toEqual([
      `contract: ${PROVIDE_NOTE}`,
      `contract: ${REQUIRE_NOTE}`,
    ]);
    // Without stored warnings the block says nothing — the parser is the one that stores them.
    expect(renderContractBlock(LOOSE)).not.toContain("contract: ");
  });

  it("a task's own line drops a require nobody provides", () => {
    expect(renderContractForTask(LOOSE, "index")).toContain(
      "You may rely on: nothing from the other parts",
    );
    expect(renderContractForTask(LOOSE, "main")).toContain(
      "You may rely on: btn-launch (id from html in index.html) — written at the same time, so it may not exist yet: code against it, do not wait for it or read it",
    );
  });

  // k8c (16-11-2026): only a file provide puts its consumer in a later
  // wave, so the consumer of a symbol is told it is written meanwhile.
  it("tells the consumer of a non-file provide it is written at the same time, and the consumer of a file that it is there", () => {
    const c = {
      provides: [
        { task: "kerne", kind: "symbol" as const, name: "Ark", in: "ark/ark.py", shape: "Ark(path).set(cell, text)" },
        { task: "kerne", kind: "file" as const, name: "ark/ark.py" },
      ],
      requires: [{ task: "cli", name: "Ark" }],
    };
    expect(renderContractForTask(c, "cli")).toContain(
      `You may rely on: Ark (symbol from kerne in ark/ark.py) — Ark(path).set(cell, text) — written at the same time, so it may not exist yet: code against it, do not wait for it or read it`,
    );
    // The same symbol from a provider this task also waits on for a file is there when it starts.
    const waited = { ...c, requires: [...c.requires, { task: "cli", name: "ark/ark.py" }] };
    expect(renderContractForTask(waited, "cli")).not.toContain("written at the same time");
  });
});

describe("contract inputs (F51)", () => {
  it("renders INPUTS first after the header, as edit-in-place files, and nothing when none are declared", () => {
    const block = renderContractBlock({
      inputs: ["sales.csv", "data/projects.json"],
      owners: { "report.md": "report" },
    });
    expect(block.split("\n").slice(1, 5)).toEqual([
      "INPUTS (the operator's own files — read and edit in place, never replace; os.fs.write on one is refused):",
      "- sales.csv",
      "- data/projects.json",
      "OWNERS (path → task; write only in paths you own):",
    ]);
    expect(renderContractBlock(CONTRACT)).not.toContain("INPUTS");
    expect(renderContractInputs(undefined)).toEqual([]);
    expect(renderContractInputs([])).toEqual([]);
  });

  it("resolves the declared inputs as the worker's tools would, skipping globs and repeats", () => {
    expect(
      resolveContractInputs(
        ["sales.csv", "data/*.csv", "/abs/x.json", "sales.csv"],
        "/repo",
      ),
    ).toEqual([resolve("/repo", "sales.csv"), resolve("/abs/x.json")]);
    expect(resolveContractInputs([], "/repo")).toEqual([]);
  });
});

// Fable 3 (k8e, 16-11-2026): the core worker wrote a test file to drive
// its own code; the judge read it as a stray and the retry ran out the
// clock with the verify green.
describe("strayWrites (Fable 3)", () => {
  const W = resolve("/repo");
  const at = (path: string): string => resolve(W, path);
  const task = { id: "core", files: ["pkg/core.py"] };
  const contract: DelegateContract = {
    owners: { "pkg/__main__.py": "cli", "pkg/models/": "core" },
    provides: [
      { task: "core", kind: "symbol", name: "Store", in: "pkg/store.py" },
      { task: "cli", kind: "file", name: "pkg/cli.py" },
    ],
    inputs: ["data.csv"],
  };

  it("names what no task is given: not its files, provides or folders, nor another's, nor an input", () => {
    const written = [
      at("pkg/core.py"),
      at("pkg/models/a.py"),
      at("pkg/store.py"),
      at("pkg/__main__.py"),
      at("pkg/cli.py"),
      at("data.csv"),
      at("probe.py"),
      at("probe.py"),
    ];
    expect(strayWrites(task, contract, written, W)).toEqual([at("probe.py")]);
  });

  it("says nothing it cannot tell: nothing declared, a glob, or autoverify's repair", () => {
    expect(strayWrites({ id: "core" }, undefined, [at("x.py")], W)).toEqual([]);
    expect(strayWrites(task, { owners: { "tests/*": "tests" } }, [at("x.py")], W)).toEqual([]);
    expect(
      strayWrites({ id: "autoverify-repair-1", files: ["a.py"] }, undefined, [at("x.py")], W),
    ).toEqual([]);
  });

  it("counts the paths of the task a split task came from as its own", () => {
    expect(
      strayWrites({ id: "core/a" }, { owners: { "pkg/": "core" } }, [at("pkg/x.py"), at("y.py")], W),
    ).toEqual([at("y.py")]);
  });

  it.runIf(process.platform === "win32")("compares without case on Windows, as the owner guard does", () => {
    expect(strayWrites(task, undefined, [at("PKG/Core.py")], W)).toEqual([]);
  });
});
