import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";
import { VisionUnsupportedError } from "../llm-provider.js";
import {
  getProviderFactory,
  type LlmProviderConfigEntry,
} from "../registry/provider-types.js";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import {
  CLAUDE_CLI_SYSTEM_PROMPT,
  claudeCliAdapter,
} from "./claude-cli-adapter.js";
import { DISCARDED_ANSWER_NOTE } from "./cli-session-chain.js";
import {
  runCliCommand,
  type CliRunOptions,
  type CliRunOutcome,
} from "./run-cli-completion.js";
import { SubscriptionCliProvider } from "./subscription-cli-provider.js";
import {
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";

const SUCCESS = JSON.stringify({
  subtype: "success",
  is_error: false,
  result: "hello",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 3 },
});

function stubRunner(stdout: string, calls: CliRunOptions[] = []) {
  return async (options: CliRunOptions): Promise<CliRunOutcome> => {
    calls.push(options);
    return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
  };
}

function makeProvider(
  overrides: Partial<Parameters<typeof buildOptions>[0]> = {},
) {
  return new SubscriptionCliProvider(buildOptions(overrides));
}

function buildOptions(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-cli",
    descriptor: claudeCliAdapter,
    cwd: "/tmp",
    runCliImpl: stubRunner(SUCCESS),
    ...overrides,
  } as ConstructorParameters<typeof SubscriptionCliProvider>[0];
}

describe("SubscriptionCliProvider capabilities", () => {
  it("declares the text (JSON-array) transport with no vision and no slot affinity", () => {
    const provider = makeProvider();
    // The tools are never forwarded to the CLI, so the prompt must ask
    // for the JSON-array tool call rather than tell the model never to
    // write tool JSON as text (F32).
    expect(provider.capabilities.toolTransport).toBe("grammar");
    expect(provider.toolCallAdapter).toBeNull();
    expect(provider.streamConsumer).toBeNull();
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.supportsSlotAffinity).toBe(false);
    expect(provider.capabilities.supportsPromptCache).toBe(true);
    expect(provider.capabilities.contextWindow).toBeGreaterThan(0);
  });

  it("rejects vision instead of pretending", async () => {
    await expect(
      makeProvider().describeImage({ prompt: "x", images: [] }),
    ).rejects.toBeInstanceOf(VisionUnsupportedError);
  });

  it("lists models without spawning anything", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    expect(await provider.listModels()).toContain("sonnet");
    expect(calls).toHaveLength(0);
  });

  it("closes without error", async () => {
    await expect(makeProvider().close()).resolves.toBeUndefined();
  });
});

describe("SubscriptionCliProvider.complete", () => {
  it("sends the prompt on stdin and never on argv", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    const prompt = "P".repeat(200_000);
    const result = await provider.complete({ prompt });

    expect(result.content).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(prompt);
    expect(calls[0]?.args.some((arg) => arg.includes("PPPP"))).toBe(false);
  });

  it("uses the configured model and appends extraArgs", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({
      model: "opus",
      extraArgs: ["--effort", "high"],
      runCliImpl: stubRunner(SUCCESS, calls),
    });
    await provider.complete({ prompt: "x" });
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args.slice(-2)).toEqual(["--effort", "high"]);
  });

  it("forwards the abort signal to the child", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    const controller = new AbortController();
    await provider.complete({ prompt: "x", signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("spawns the CLI without the keys that would bill the API", async () => {
    // ATO-176: the anthropic provider's key in `.env` moved a
    // "Claude Code subscription" user onto per-token billing.
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    await provider.complete({ prompt: "x" });
    expect(calls[0]?.stripEnv).toEqual(claudeCliAdapter.billingEnvKeys);
    expect(calls[0]?.stripEnv).toContain("ANTHROPIC_API_KEY");
    // And names the tool, for the not-installed message (ATO-117).
    expect(calls[0]?.productName).toBe("Claude Code");
  });

  it("passes responseFormat through as --json-schema", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({ runCliImpl: stubRunner(SUCCESS, calls) });
    await provider.complete({
      prompt: "x",
      responseFormat: { name: "vote", schema: { type: "object" } },
    });
    expect(calls[0]?.args).toContain("--json-schema");
  });
});

describe("SubscriptionCliProvider.completeStream", () => {
  it("falls back to one buffered chunk when streaming is disabled", async () => {
    const provider = makeProvider({ streaming: false });
    const deltas: string[] = [];
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) deltas.push(next.value.delta);
      next = await iterator.next();
    }
    expect(deltas).toEqual(["hello"]);
    expect(next.value.content).toBe("hello");
  });

  it("streams deltas and returns the parsed final envelope", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "he" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "llo" },
        },
      }),
      SUCCESS.replace('"subtype"', '"type":"result","subtype"'),
    ];
    const provider = makeProvider({
      streamCliImpl: async function* () {
        for (const line of lines) yield line;
      },
    });
    const deltas: string[] = [];
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) deltas.push(next.value.delta);
      next = await iterator.next();
    }
    expect(deltas).toEqual(["he", "llo"]);
    expect(next.value.content).toBe("hello");
  });

  it("emits the final text once when no delta was recognised", async () => {
    // Safety net for a stream schema we do not control: a mismatch must
    // degrade to buffered behaviour, never to an empty turn.
    const provider = makeProvider({
      streamCliImpl: async function* () {
        yield JSON.stringify({
          type: "stream_event",
          event: { type: "unknown" },
        });
        yield SUCCESS.replace('"subtype"', '"type":"result","subtype"');
      },
    });
    const deltas: string[] = [];
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) deltas.push(next.value.delta);
      next = await iterator.next();
    }
    expect(deltas).toEqual(["hello"]);
  });

  it("fails loudly when the stream ends with no result envelope", async () => {
    const provider = makeProvider({
      streamCliImpl: async function* () {
        yield JSON.stringify({ type: "system" });
      },
    });
    const iterator = provider.completeStream({ prompt: "x" });
    await expect(
      (async () => {
        let next = await iterator.next();
        while (!next.done) next = await iterator.next();
      })(),
    ).rejects.toThrow(/without a result envelope/);
  });

  it("routes rate-limit notices to onNotice instead of failing", async () => {
    const notices: string[] = [];
    const provider = makeProvider({
      onNotice: (message: string) => notices.push(message),
      streamCliImpl: async function* () {
        yield JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        });
        yield SUCCESS.replace('"subtype"', '"type":"result","subtype"');
      },
    });
    const iterator = provider.completeStream({ prompt: "x" });
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    expect(notices).toEqual(["claude rate limit rejected (five_hour)"]);
  });
});

describe("SubscriptionCliProvider CLI session", () => {
  const FIXED = "### system 0\npersona\n\n### tools\nfs.read";
  const HEAD =
    "### capabilities\nworking_dir: /w\n\n### conversation\nuser: do it";
  const ARGS = { path: "a.txt" };
  const ANSWER = JSON.stringify([{ tool: "fs.read", args: ARGS }]);
  const CALL_LINE = `assistant_tool_call: fs.read ${JSON.stringify(ARGS)}\n`;
  const RESULT_LINE = "tool_result[fs.read] (ok): hello\n";
  const TAIL = "\n<think>\n";
  const FIRST = `${FIXED}\n\n${HEAD}${TAIL}`;
  const SECOND = `${FIXED}\n\n${HEAD}\n${CALL_LINE}${RESULT_LINE}${TAIL}`;
  const envelope = (result: string) =>
    JSON.stringify({ ...JSON.parse(SUCCESS), type: "result", result });

  interface Seen {
    args: readonly string[];
    input: string | undefined;
    system: string | undefined;
    systemFile: string | undefined;
  }
  const after = (seen: Seen | undefined, flag: string) => {
    const at = seen?.args.indexOf(flag) ?? -1;
    return at < 0 ? undefined : seen?.args[at + 1];
  };
  // The system file only lives for the duration of the call.
  function record(options: CliRunOptions, seen: Seen[]): void {
    const at = options.args.indexOf("--system-prompt-file");
    const systemFile = at < 0 ? undefined : options.args[at + 1];
    seen.push({
      args: options.args,
      input: options.input,
      systemFile,
      system: systemFile ? readFileSync(systemFile, "utf8") : undefined,
    });
  }
  function recordingRunner(
    seen: Seen[],
    refuse: (call: number) => boolean = () => false,
  ) {
    return async (options: CliRunOptions): Promise<CliRunOutcome> => {
      record(options, seen);
      if (refuse(seen.length)) {
        throw new SubscriptionCliInvocationError("No conversation found", 1);
      }
      return { stdout: envelope(ANSWER), stderr: "", exitCode: 0, durationMs: 1 };
    };
  }
  const buffered = (seen: Seen[], refuse?: (call: number) => boolean) =>
    makeProvider({ streaming: false, runCliImpl: recordingRunner(seen, refuse) });

  it("opens a CLI session, then resumes it with only what is new", async () => {
    const seen: Seen[] = [];
    const provider = buffered(seen);
    await provider.complete({ prompt: FIRST, sessionId: "s1" });
    await provider.complete({ prompt: SECOND, sessionId: "s1" });

    const id = after(seen[0], "--session-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.system).toBe(`${CLAUDE_CLI_SYSTEM_PROMPT}\n\n${FIXED}`);
    expect(seen[0]?.input).toBe(`${HEAD}${TAIL}`);
    expect(seen[0]?.args).not.toContain("--no-session-persistence");
    expect(existsSync(seen[0]?.systemFile ?? "")).toBe(false);

    // The answer already stands in the CLI's session; only the tool
    // result is new. The fixed part is byte-identical call to call.
    expect(after(seen[1], "--resume")).toBe(id);
    expect(seen[1]?.input).toBe(`${RESULT_LINE}${TAIL}`);
    expect(seen[1]?.system).toBe(seen[0]?.system);
  });

  it("asks again in the same session when the same prompt comes again", async () => {
    const seen: Seen[] = [];
    const provider = buffered(seen);
    await provider.complete({ prompt: FIRST, sessionId: "s1" });
    await provider.complete({ prompt: FIRST, sessionId: "s1" });
    await provider.complete({ prompt: SECOND, sessionId: "s1" });

    const id = after(seen[0], "--session-id");
    expect(after(seen[1], "--resume")).toBe(id);
    expect(seen[1]?.input).toBe(DISCARDED_ANSWER_NOTE);
    // The conversation continues from the answer that replaced it.
    expect(after(seen[2], "--resume")).toBe(id);
    expect(seen[2]?.input).toBe(`${RESULT_LINE}${TAIL}`);
  });

  it("keeps each conversation on its own session", async () => {
    const seen: Seen[] = [];
    const provider = buffered(seen);
    await provider.complete({ prompt: FIRST, sessionId: "s1" });
    await provider.complete({ prompt: FIRST, sessionId: "s2" });
    await provider.complete({ prompt: SECOND, sessionId: "s1" });

    expect(after(seen[2], "--resume")).toBe(after(seen[0], "--session-id"));
  });

  it("stays stateless without a conversation, for a schema call, and for another prompt layout", async () => {
    const seen: Seen[] = [];
    const provider = buffered(seen);
    await provider.complete({ prompt: FIRST });
    await provider.complete({
      prompt: FIRST,
      sessionId: "s1",
      responseFormat: { name: "x", schema: { type: "object" } },
    });
    await provider.complete({ prompt: "summarise this", sessionId: "s1" });

    for (const call of seen) {
      expect(call.args).toContain("--no-session-persistence");
      expect(after(call, "--system-prompt")).toBe(CLAUDE_CLI_SYSTEM_PROMPT);
      expect(call.systemFile).toBeUndefined();
    }
    expect(seen.map((call) => call.input)).toEqual([
      FIRST,
      FIRST,
      "summarise this",
    ]);
  });

  it("retries a refused resume once, as a new session with the whole conversation", async () => {
    const seen: Seen[] = [];
    const provider = buffered(seen, (call) => call === 2);
    await provider.complete({ prompt: FIRST, sessionId: "s1" });
    const result = await provider.complete({ prompt: SECOND, sessionId: "s1" });

    expect(result.content).toBe(ANSWER);
    expect(seen).toHaveLength(3);
    expect(after(seen[1], "--resume")).toBe(after(seen[0], "--session-id"));
    expect(after(seen[2], "--resume")).toBeUndefined();
    expect(after(seen[2], "--session-id")).not.toBe(
      after(seen[0], "--session-id"),
    );
    expect(seen[2]?.input).toBe(`${HEAD}\n${CALL_LINE}${RESULT_LINE}${TAIL}`);
  });

  it("does not retry a refused new session, or a cancelled resume", async () => {
    const opening: Seen[] = [];
    await expect(
      buffered(opening, () => true).complete({ prompt: FIRST, sessionId: "s1" }),
    ).rejects.toBeInstanceOf(SubscriptionCliInvocationError);
    expect(opening).toHaveLength(1);

    const seen: Seen[] = [];
    const provider = buffered(seen, (call) => call === 2);
    await provider.complete({ prompt: FIRST, sessionId: "s1" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete({
        prompt: SECOND,
        sessionId: "s1",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCliInvocationError);
    expect(seen).toHaveLength(2);
  });

  it("continues the session across streamed calls", async () => {
    const seen: Seen[] = [];
    const provider = makeProvider({
      streamCliImpl: async function* (options: CliRunOptions) {
        record(options, seen);
        if (seen.length === 2) {
          throw new SubscriptionCliInvocationError("No conversation found", 1);
        }
        yield envelope(ANSWER);
      },
    });
    const drain = async (prompt: string) => {
      const iterator = provider.completeStream({ prompt, sessionId: "s1" });
      let next = await iterator.next();
      while (!next.done) next = await iterator.next();
      return next.value;
    };
    await drain(FIRST);
    const result = await drain(SECOND);
    await drain(`${SECOND.slice(0, -TAIL.length)}\n${RESULT_LINE}${TAIL}`);

    expect(result.content).toBe(ANSWER);
    expect(seen[0]?.args).toContain("stream-json");
    expect(after(seen[1], "--resume")).toBe(after(seen[0], "--session-id"));
    expect(seen[1]?.input).toBe(`${RESULT_LINE}${TAIL}`);
    // Refused before any text streamed: one more try as a new session,
    // and the call after that resumes the new one.
    expect(seen[2]?.input).toBe(`${HEAD}\n${CALL_LINE}${RESULT_LINE}${TAIL}`);
    expect(after(seen[3], "--resume")).toBe(after(seen[2], "--session-id"));
    expect(seen[3]?.input).toBe(`${RESULT_LINE}${TAIL}`);
  });
});

describe("SubscriptionCliProvider.health", () => {
  it("is reachable when the version probe exits cleanly", async () => {
    const calls: CliRunOptions[] = [];
    const provider = makeProvider({
      runCliImpl: stubRunner("2.1.220 (Claude Code)", calls),
    });
    const health = await provider.health();
    expect(health.reachable).toBe(true);
    expect(calls[0]?.args).toEqual(["--version"]);
    // A health probe must never send a prompt or cost tokens.
    expect(calls[0]?.input).toBeUndefined();
    expect(calls[0]?.stripEnv).toEqual(claudeCliAdapter.billingEnvKeys);
  });

  it("reports an actionable message when the binary is missing", async () => {
    const provider = makeProvider({
      runCliImpl: async () => {
        throw new SubscriptionCliNotInstalledError("claude", "Install it.");
      },
    });
    const health = await provider.health();
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/not found on PATH/);
  });

  it("says Claude Code is not installed when the command is missing", async () => {
    // ATO-117. The real runner, so the spawn's own ENOENT is what gets
    // worded; nothing that exists is ever started.
    const provider = makeProvider({
      binPath: "definitely-not-a-real-binary-xyz",
      runCliImpl: runCliCommand,
    });
    const health = await provider.health();
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(
      /^Claude Code isn't installed \(the `definitely-not-a-real-binary-xyz` command was not found\)\. Install Claude Code and sign in, or choose another provider\./,
    );
  });
});

describe("registry factory", () => {
  it("builds the provider from a subscription-cli entry", async () => {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("subscription-cli");
    expect(factory).toBeDefined();
    const entry: LlmProviderConfigEntry = {
      id: "claude-cli",
      kind: "subscription-cli",
      defaultChatModel: "opus",
      subscriptionCli: { cli: "claude" },
    };
    const provider = await factory!({
      config: getConfig() as AtomicAgentConfig,
      entry,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });
    expect(provider).toBeInstanceOf(SubscriptionCliProvider);
    expect(provider.id).toBe("claude-cli");
  });

  it("refuses an entry with no subscriptionCli block", () => {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("subscription-cli")!;
    // Config parsing rejects this first; the factory guard is the
    // backstop for an entry built in code rather than loaded from disk.
    expect(() =>
      factory({
        config: getConfig() as AtomicAgentConfig,
        entry: { id: "claude-cli", kind: "subscription-cli" },
        logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      }),
    ).toThrow(/requires a subscriptionCli block/);
  });
});
