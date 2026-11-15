import { describe, expect, it } from "vitest";

import type { CapabilitiesSummary } from "./stable-prefix.js";
import {
  fusionDelegateAutoVerifyArgsJsonSchema,
  getDefaultArgsJsonSchema,
} from "./default-tool-args-schemas.js";
import {
  AUTOVERIFY_DELEGATE_SENTENCE,
  withAutoVerifyDelegate,
} from "./fusion-delegate-autoverify.js";
import {
  AUTOVERIFY_VERIFY_LINE,
  buildFusionGuidance,
  FUSION_DELEGATE_TOOL,
  FUSION_GUIDANCE,
  isAutoVerifyMounted,
} from "./fusion-guidance.js";
import { buildStablePrefix, type ToolDescriptor } from "./stable-prefix.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "./tool-descriptors.js";

const CAPS = { platform: "linux" } as unknown as CapabilitiesSummary;

function delegateDescriptor(): ToolDescriptor {
  const found = DEFAULT_TOOL_DESCRIPTORS.find((d) => d.name === FUSION_DELEGATE_TOOL);
  if (found === undefined) throw new Error("fusion.delegate is not a default descriptor");
  return found;
}

const prefix = (descriptors: readonly ToolDescriptor[]): string =>
  buildStablePrefix({ toolDescriptors: descriptors, capabilities: CAPS, skillCatalog: [] });

describe("autoverify on fusion.delegate (lever F1)", () => {
  it("flag off: the static schema has no `verify` and the guidance keeps its line", () => {
    const schema = getDefaultArgsJsonSchema(FUSION_DELEGATE_TOOL) as { properties: Record<string, unknown> };
    expect(schema.properties.verify).toBeUndefined();
    expect(delegateDescriptor().summary).not.toContain(AUTOVERIFY_DELEGATE_SENTENCE);
    expect(isAutoVerifyMounted(DEFAULT_TOOL_DESCRIPTORS)).toBe(false);
    expect(buildFusionGuidance(undefined, {})).toBe(buildFusionGuidance());
    expect(buildFusionGuidance()).toContain(FUSION_GUIDANCE);
  });

  it("flag on: one more sentence, `verify` in the sketch and the schema, nothing else touched", () => {
    const base = delegateDescriptor();
    const on = withAutoVerifyDelegate(base);
    expect(on.summary).toBe(`${base.summary} ${AUTOVERIFY_DELEGATE_SENTENCE}`);
    expect(on.argsSchema.indexOf("verify?:")).toBeGreaterThan(-1);
    expect(on.argsSchema.indexOf("verify?:")).toBeLessThan(on.argsSchema.indexOf("resume?:"));
    expect(on.argsSchema.replace(/verify\?: .*?\*\/, /, "")).toBe(base.argsSchema);
    const schema = on.argsJsonSchema as { properties: Record<string, unknown> };
    expect(schema.properties.verify).toBe(getDefaultArgsJsonSchema("verify.run"));
    const { verify: _verify, ...rest } = schema.properties;
    expect(rest).toEqual((getDefaultArgsJsonSchema(FUSION_DELEGATE_TOOL) as { properties: object }).properties);
    if (base.compact !== undefined) {
      expect(on.compact?.summary).toBe(`${base.compact.summary} ${AUTOVERIFY_DELEGATE_SENTENCE}`);
    }
    // Every other descriptor is the same object.
    for (const d of DEFAULT_TOOL_DESCRIPTORS) {
      if (d.name !== FUSION_DELEGATE_TOOL) expect(withAutoVerifyDelegate(d)).toBe(d);
    }
    // One schema object per process: the prefix bytes cannot drift.
    expect(fusionDelegateAutoVerifyArgsJsonSchema()).toBe(fusionDelegateAutoVerifyArgsJsonSchema());
  });

  it("the guidance swaps exactly the verify line when the mounted delegate takes `verify`", () => {
    const off = buildFusionGuidance().split("\n");
    const on = buildFusionGuidance(undefined, { autoVerify: true }).split("\n");
    expect(on).toHaveLength(off.length);
    const changed = on.flatMap((line, i) => (line === off[i] ? [] : [[off[i], line]]));
    expect(changed).toEqual([
      [
        "Before accepting a fan-out: `verify.syntax` on the declared files and `verify.run` on what the request must do.",
        AUTOVERIFY_VERIFY_LINE,
      ],
    ]);
    const mounted = DEFAULT_TOOL_DESCRIPTORS.map(withAutoVerifyDelegate);
    expect(isAutoVerifyMounted(mounted)).toBe(true);
    expect(prefix(mounted)).toContain(AUTOVERIFY_VERIFY_LINE);
    expect(prefix(DEFAULT_TOOL_DESCRIPTORS)).not.toContain(AUTOVERIFY_VERIFY_LINE);
    // Deterministic: the same catalog renders the same prefix.
    expect(prefix(mounted)).toBe(prefix(DEFAULT_TOOL_DESCRIPTORS.map(withAutoVerifyDelegate)));
  });
});
