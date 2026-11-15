import { describe, expect, it } from "vitest";

import type { ResolvedRunMode } from "../../llm/run-mode/index.js";

import { fusionAuxProviderId, pinToFusionWorker } from "./fusion-aux-route.js";

function mode(effective: ResolvedRunMode["effective"], workerProviderId: string | null): ResolvedRunMode {
  return {
    stored: effective, effective, primaryProviderId: "cloud", degraded: null,
    orchestratorProviderId: "cloud", orchestratorModel: null,
    workerProviderId, workerModel: null, workers: 1, workersPinned: false,
    workerMaxSteps: 12, workerTimeoutMs: 60_000,
  };
}

describe("fusionAuxProviderId", () => {
  it("names the worker leg only in fusion with a worker", () => {
    expect(fusionAuxProviderId(mode("fusion", "local"))).toBe("local");
    expect(fusionAuxProviderId(mode("fusion", null))).toBeUndefined();
    expect(fusionAuxProviderId(mode("cloud", "local"))).toBeUndefined();
  });
});

describe("pinToFusionWorker", () => {
  it("pins unpinned calls in fusion, re-reading the mode per call", async () => {
    let current = mode("fusion", "local");
    const seen: Array<string | undefined> = [];
    const complete = pinToFusionWorker(async (params: { providerId?: string }) => {
      seen.push(params.providerId);
      return null;
    }, () => current);
    await complete({});
    current = mode("cloud", "local");
    await complete({});
    expect(seen).toEqual(["local", undefined]);
  });

  it("keeps a caller's own pin", async () => {
    const seen: Array<string | undefined> = [];
    const complete = pinToFusionWorker(async (params: { providerId?: string }) => {
      seen.push(params.providerId);
      return null;
    }, () => mode("fusion", "local"));
    await complete({ providerId: "judge" });
    expect(seen).toEqual(["judge"]);
  });
});
