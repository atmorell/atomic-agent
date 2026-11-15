import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findNameMisses,
  formatNameSteer,
  readWrittenFiles,
  requestCallNames,
} from "./request-names.js";

// The shape of the request that produced `Lager.sem` three runs in a row.
const REQUEST =
  "(2) opg/lager.py har klassen Lager(sti), der gemmer i en JSON-fil: hent() returnerer en liste af Opgave, " +
  "og gem(opgaver) skriver hele listen som JSON i UTF-8 - en liste af dicts fra til_dict. " +
  "(3) opg/tjenester.py har klassen Opgaveliste(lager) med metoderne tilfoej(tekst, prioritet=2) og slet(id); " +
  "noeglerne til_dict() og fra_dict(d).";

const LAGER_SEM = [
  "class Lager:",
  "    def __init__(self, sti):",
  "        self.sti = sti",
  "    def hent(self):",
  "        return []",
  "    def sem(self, opgaver):",
  "        data = [o.til_dict() for o in opgaver]",
].join("\n");

describe("requestCallNames", () => {
  it("takes the names the request writes as calls, three characters or more", () => {
    expect(requestCallNames(REQUEST)).toEqual([
      "Lager", "hent", "gem", "Opgaveliste", "tilfoej", "slet", "til_dict", "fra_dict",
    ]);
  });

  it("does not split a name at a non-ASCII letter", () => {
    expect(requestCallNames("en nøgle(x) og gem(y)")).toEqual(["gem"]);
  });
});

describe("findNameMisses", () => {
  it("finds the worker's sem for the request's gem, in the definition and the tests", () => {
    const misses = findNameMisses(REQUEST, [
      { path: "opg/lager.py", text: LAGER_SEM },
      { path: "test_opg.py", text: "def test_gem(tmp_path):\n    lager.sem([])\n" },
    ]);
    expect(misses).toEqual([{ expected: "gem", found: "sem", file: "opg/lager.py" }]);
  });

  it("says nothing once any written file calls or defines the request's name", () => {
    expect(
      findNameMisses(REQUEST, [
        { path: "opg/lager.py", text: LAGER_SEM },
        { path: "opg/tjenester.py", text: "self.lager.gem(self.opgaver)\n" },
      ]),
    ).toEqual([]);
  });

  it("still steers when the name is only in a comment", () => {
    const misses = findNameMisses(REQUEST, [
      { path: "opg/lager.py", text: `# gem hele listen\n${LAGER_SEM}` },
    ]);
    expect(misses.map((m) => m.found)).toEqual(["sem"]);
  });

  it("leaves a common library call alone: d.get( is not the request's gem", () => {
    expect(
      findNameMisses(REQUEST, [
        { path: "opg/cli.py", text: "frist = args.get('frist')\nprint(d.get('id'))\n" },
      ]),
    ).toEqual([]);
  });

  it("leaves a name the request itself uses as a word", () => {
    const request = "Lav gem(x). Klassen har ogsaa feltet sem.";
    expect(findNameMisses(request, [{ path: "a.py", text: "def sem(self):\n    pass\n" }])).toEqual([]);
  });

  it("needs the same length and exactly one character off", () => {
    expect(
      findNameMisses(REQUEST, [
        { path: "a.py", text: "def gemme(self):\n    pass\ndef sat(self):\n    pass\n" },
      ]),
    ).toEqual([]);
  });

  it("is empty without written files or call names", () => {
    expect(findNameMisses(REQUEST, [])).toEqual([]);
    expect(findNameMisses("no calls here", [{ path: "a.py", text: LAGER_SEM }])).toEqual([]);
  });
});

describe("formatNameSteer", () => {
  it("names both spellings and the file, and leaves a different function alone", () => {
    const text = formatNameSteer([{ expected: "gem", found: "sem", file: "opg/lager.py" }]);
    expect(text).toContain("`gem(`");
    expect(text).toContain("`sem`");
    expect(text).toContain("opg/lager.py");
    expect(text).toContain("spelled exactly as the request spells it");
    expect(text).toContain("If it is a different function, leave it.");
  });
});

describe("readWrittenFiles", () => {
  it("resolves relative paths against the working folder and skips missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "request-names-"));
    try {
      writeFileSync(join(dir, "lager.py"), LAGER_SEM);
      const files = readWrittenFiles(["lager.py", "gone.py"], dir);
      expect(files).toEqual([{ path: "lager.py", text: LAGER_SEM }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
