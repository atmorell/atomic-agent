import { describe, expect, it } from "vitest";

import { withAutoVerifyDelegate } from "../../prompt/fusion-delegate-autoverify.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import { sessionArgsSchemaFor } from "./step-batch-policy.js";

describe("sessionArgsSchemaFor (the unknown-argument guard's schema)", () => {
  it("is undefined for the default catalog: the guard keeps its static schemas", () => {
    const schemaFor = sessionArgsSchemaFor(DEFAULT_TOOL_DESCRIPTORS);
    for (const d of DEFAULT_TOOL_DESCRIPTORS) expect(schemaFor(d.name), d.name).toBeUndefined();
  });

  it("is the advertised schema for the flag-on fusion.delegate only", () => {
    const mounted = DEFAULT_TOOL_DESCRIPTORS.map(withAutoVerifyDelegate);
    const schemaFor = sessionArgsSchemaFor(mounted);
    const delegate = mounted.find((d) => d.name === "fusion.delegate")!;
    expect(schemaFor("fusion.delegate")).toBe(delegate.argsJsonSchema);
    expect(schemaFor("verify.run")).toBeUndefined();
    // A tool with no static schema (MCP) stays exempt whatever it advertises.
    const mcp = sessionArgsSchemaFor([
      { name: "mcp.x.y", summary: "", argsSchema: "{}", argsJsonSchema: { type: "object" } },
    ]);
    expect(mcp("mcp.x.y")).toBeUndefined();
  });
});
