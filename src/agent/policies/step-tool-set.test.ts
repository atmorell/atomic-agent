import { describe, expect, it } from "vitest";

import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import {
  narrowDescriptorsToToolSet,
  toolSetAdmits,
  toolSetRefusal,
  writeScopeAdmits,
  writeScopeRefusal,
  type StepToolSet,
} from "./step-tool-set.js";

const SET: StepToolSet = {
  names: ["fusion.delegate", "reply", "finish"],
  reason: "review stalled: delegate or reply",
};

const d = (name: string): ToolDescriptor => ({
  name,
  summary: name,
  argsSchema: "{}",
});

describe("step-tool-set", () => {
  it("admits exactly its names", () => {
    expect(toolSetAdmits(SET, "reply")).toBe(true);
    expect(toolSetAdmits(SET, "fusion.delegate")).toBe(true);
    expect(toolSetAdmits(SET, "os.fs.read")).toBe(false);
  });

  it("narrows a descriptor list to the set, and returns the same array when nothing is removed", () => {
    const all = [d("os.fs.read"), d("fusion.delegate"), d("reply"), d("finish")];
    expect(narrowDescriptorsToToolSet(all, SET).map((x) => x.name)).toEqual([
      "fusion.delegate",
      "reply",
      "finish",
    ]);
    const already = [d("reply"), d("finish")];
    // Identity matters: the native-tools adapter memoises on it.
    expect(narrowDescriptorsToToolSet(already, SET)).toBe(already);
  });

  it("the refusal opens with the reason and names the exits", () => {
    const refusal = toolSetRefusal("os.fs.read", SET);
    expect(refusal.status).toBe("error");
    expect(refusal.summary).toBe(
      "review stalled: delegate or reply: `os.fs.read` was not run; this step admits only `fusion.delegate`, `reply`, `finish`",
    );
    expect(refusal.details).toEqual({
      tool_set: true,
      tool: "os.fs.read",
      admitted: ["fusion.delegate", "reply", "finish"],
    });
  });
});

// Greb K: a fusion worker's written files are changed with os.fs.edit.
describe("write scope", () => {
  const open = ["C:\\w\\ark\\cli.py", "ark/cli.py"];

  it("admits a listed path up to separators, a leading ./ and Windows case", () => {
    expect(writeScopeAdmits(open, "C:\\w\\ark\\cli.py", "win32")).toBe(true);
    expect(writeScopeAdmits(open, "C:/w/ark/cli.py", "win32")).toBe(true);
    expect(writeScopeAdmits(open, "c:\\W\\ark\\CLI.py", "win32")).toBe(true);
    expect(writeScopeAdmits(open, "./ark/cli.py", "linux")).toBe(true);
    expect(writeScopeAdmits(open, "ark/CLI.py", "linux")).toBe(false);
  });

  it("refuses an unlisted path, a missing one and every path under an empty scope", () => {
    expect(writeScopeAdmits(open, "C:\\w\\ark\\core.py", "win32")).toBe(false);
    expect(writeScopeAdmits(open, undefined, "win32")).toBe(false);
    expect(writeScopeAdmits(open, "", "win32")).toBe(false);
    expect(writeScopeAdmits([], "ark/cli.py", "win32")).toBe(false);
  });

  it("the refusal names the path, the open files and os.fs.edit", () => {
    const refusal = writeScopeRefusal("ark/core.py", ["ark/cli.py"]);
    expect(refusal.tool).toBe("os.fs.write");
    expect(refusal.status).toBe("error");
    expect(refusal.summary).toBe(
      "`ark/core.py` was not written: `os.fs.write` takes only `ark/cli.py` this step; change a written file with `os.fs.edit`",
    );
    expect(refusal.details).toEqual({ write_scope: true, path: "ark/core.py", admitted: ["ark/cli.py"] });
    expect(writeScopeRefusal("ark/core.py", []).summary).toBe(
      "`ark/core.py` was not written: every file of your task is written; change it with `os.fs.edit`",
    );
  });
});
