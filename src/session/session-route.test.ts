import { describe, expect, it } from "vitest";
import type { UserLlmRunModeConfig } from "../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { resolveRunMode } from "../llm/run-mode/resolve-run-mode.js";
import {
  SESSION_ROUTE_METADATA_KEY,
  cliEffort,
  readSessionRoute,
  resolveTurnRoute,
  sameSessionRoute,
} from "./session-route.js";

function llm(
  active: string,
  models: { aimlapi?: string } = {},
  runMode?: UserLlmRunModeConfig,
): ResolvedLlmConfig {
  return {
    activeTextProvider: active,
    activeEmbeddingProvider: "local-llama",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      {
        id: "aimlapi",
        kind: "openai-compatible",
        defaultChatModel: models.aimlapi ?? "deepseek/deepseek-v4-flash",
      },
      { id: "openrouter", kind: "openrouter", defaultChatModel: "x/y" },
    ],
    toolTransport: "auto",
    ...(runMode ? { runMode } : {}),
  };
}

function route(
  resolved: ResolvedLlmConfig,
  extra: { pinnedProviderId?: string; fallbackOverrideId?: string | null } = {},
) {
  return resolveTurnRoute({
    resolved,
    runMode: resolveRunMode(resolved, { managedModelId: "qwen-3.5-4b" }),
    managedModelId: "qwen-3.5-4b",
    ...extra,
  });
}

describe("resolveTurnRoute", () => {
  it("resolves the active cloud provider and its chat model", () => {
    expect(route(llm("aimlapi"))).toEqual({
      mode: "cloud",
      main: { providerId: "aimlapi", model: "deepseek/deepseek-v4-flash" },
      worker: null,
    });
  });

  it("names a local link by the managed model", () => {
    expect(route(llm("local-llama"))).toEqual({
      mode: "local",
      main: { providerId: "local-llama", model: "qwen-3.5-4b" },
      worker: null,
    });
  });

  it("is stable for an unchanged config and differs on provider or model switch", () => {
    const a = route(llm("aimlapi"));
    expect(sameSessionRoute(a, route(llm("aimlapi")))).toBe(true);
    expect(sameSessionRoute(a, route(llm("openrouter")))).toBe(false);
    expect(
      sameSessionRoute(
        a,
        route(llm("aimlapi", { aimlapi: "anthropic/claude-sonnet-5" })),
      ),
    ).toBe(false);
  });

  it("starts on a sticky fallover link, and a pin wins over both", () => {
    expect(
      route(llm("aimlapi"), { fallbackOverrideId: "local-llama" }).main,
    ).toEqual({ providerId: "local-llama", model: "qwen-3.5-4b" });
    expect(
      route(llm("aimlapi"), {
        fallbackOverrideId: "local-llama",
        pinnedProviderId: "openrouter",
      }).main,
    ).toEqual({ providerId: "openrouter", model: "x/y" });
  });

  it("carries both legs in fusion", () => {
    expect(route(llm("aimlapi", {}, { mode: "fusion" }))).toEqual({
      mode: "fusion",
      main: { providerId: "aimlapi", model: "deepseek/deepseek-v4-flash" },
      worker: { providerId: "local-llama", model: "qwen-3.5-4b" },
    });
  });
});

describe("readSessionRoute", () => {
  it("round-trips a stored route", () => {
    const r = route(llm("aimlapi", {}, { mode: "fusion" }));
    const stored = JSON.parse(
      JSON.stringify({ [SESSION_ROUTE_METADATA_KEY]: r }),
    ) as Record<string, unknown>;
    expect(readSessionRoute(stored)).toEqual(r);
  });

  it("reads a malformed or absent value as no route", () => {
    expect(readSessionRoute(undefined)).toBeNull();
    expect(readSessionRoute({})).toBeNull();
    expect(readSessionRoute({ [SESSION_ROUTE_METADATA_KEY]: "x" })).toBeNull();
    expect(
      readSessionRoute({
        [SESSION_ROUTE_METADATA_KEY]: { mode: "warp", main: { providerId: "a" } },
      }),
    ).toBeNull();
    expect(
      readSessionRoute({
        [SESSION_ROUTE_METADATA_KEY]: { mode: "cloud", main: { providerId: "" } },
      }),
    ).toBeNull();
  });
});

describe("the fusion hierarchy on the route", () => {
  const resolved: ResolvedLlmConfig = {
    activeTextProvider: "claude-cli",
    activeEmbeddingProvider: "local-llama",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      {
        id: "claude-cli",
        kind: "subscription-cli",
        defaultChatModel: "claude-opus-5-5",
        subscriptionCli: { cli: "claude", extraArgs: ["--effort", "medium"] },
      },
      {
        id: "claude-cli-high",
        kind: "subscription-cli",
        defaultChatModel: "claude-opus-5-5",
        subscriptionCli: { cli: "claude", extraArgs: ["--effort=high"] },
      },
      {
        id: "claude-fable",
        kind: "subscription-cli",
        defaultChatModel: "claude-fable-5-1",
        subscriptionCli: { cli: "claude" },
      },
    ],
    toolTransport: "auto",
    runMode: {
      mode: "fusion",
      fusion: {
        workerReasoning: "low",
        escalation: "advisor",
        escalationProvider: "claude-cli-high",
        questionProvider: "claude-fable",
        judge: "on",
      },
    },
  };

  it("names every leg with its effort", () => {
    const r = route(resolved);
    expect(r.main).toEqual({ providerId: "claude-cli", model: "claude-opus-5-5", effort: "medium" });
    expect(r.worker).toEqual({ providerId: "local-llama", model: "qwen-3.5-4b", effort: "low" });
    expect(r.escalation).toEqual({ providerId: "claude-cli-high", model: "claude-opus-5-5", effort: "high" });
    expect(r.question).toEqual({ providerId: "claude-fable", model: "claude-fable-5-1" });
    expect(r.judge).toEqual({ providerId: "claude-cli", model: "claude-opus-5-5", effort: "medium" });
  });

  it("leaves the advisor out while escalation is off, and compares only the answering legs", () => {
    const off: ResolvedLlmConfig = {
      ...resolved,
      runMode: { mode: "fusion", fusion: { escalationProvider: "claude-cli-high" } },
    };
    const r = route(off);
    expect(r.escalation).toBeUndefined();
    expect(r.question).toBeUndefined();
    expect(r.judge).toBeUndefined();
    expect(sameSessionRoute(r, route(resolved))).toBe(true);
  });
});

describe("cliEffort", () => {
  it("reads both spellings and nothing else", () => {
    expect(cliEffort(["--effort", "high"])).toBe("high");
    expect(cliEffort(["--model", "x", "--effort=max"])).toBe("max");
    expect(cliEffort(["--effort"])).toBeUndefined();
    expect(cliEffort(undefined)).toBeUndefined();
    expect(cliEffort(["--verbose"])).toBeUndefined();
  });
});
