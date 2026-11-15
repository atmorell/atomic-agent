import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
} from "../completion-types.js";
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderHealthResult,
  VisionRequest,
  VisionResult,
} from "../llm-provider.js";
import { VisionUnsupportedError } from "../llm-provider.js";
import type { RateLimitWindow } from "../rate-limits.js";
import type { ToolCallAdapter } from "../adapters/tool-call-adapter.js";
import type {
  CliAdapterDescriptor,
  CliArgsInput,
  CliStreamEvent,
} from "./cli-adapter-descriptor.js";
import {
  planCliSessionTurn,
  restartCliSessionTurn,
  type CliSessionLink,
  type CliSessionTurn,
} from "./cli-session-chain.js";
import { withoutReasoningOpener } from "./strip-reasoning-opener.js";
import { ToolCallArrayCut } from "./tool-call-array-cut.js";
import { resolveCliBinary } from "./resolve-cli-binary.js";
import { runCliCommand, type CliRunner } from "./run-cli-completion.js";
import {
  streamCliCommand,
  type CliStreamRunner,
} from "./stream-cli-completion.js";
import { SubscriptionCliInvocationError } from "./subscription-cli-errors.js";

/** Matches `OpenAiProvider`'s default; a CLI turn is never quick. */
const DEFAULT_TIMEOUT_MS = 600_000;
/**
 * `runCommand` defaults to 256 KiB, which would silently truncate a long
 * completion and hand `JSON.parse` a torn object.
 */
const MAX_COMPLETION_BYTES = 8 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_HEALTH_BYTES = 64 * 1024;
/** Conversations whose CLI session is remembered; the oldest goes first. */
const MAX_TRACKED_SESSIONS = 64;
/** Output-token estimate for an answer cut short (`cutResult`). */
const CUT_CHARS_PER_TOKEN = 2;

export interface SubscriptionCliProviderOptions {
  id: string;
  descriptor: CliAdapterDescriptor;
  /** Working directory for the child — the state dir, not the agent's cwd. */
  cwd: string;
  model?: string;
  binPath?: string;
  extraArgs?: readonly string[];
  streaming?: boolean;
  maxBudgetUsd?: number;
  requestTimeoutMs?: number;
  /**
   * Stop a streamed answer at the end of its opening tool-call array
   * (`ToolCallArrayCut`). The CLI's session then lacks that answer, so
   * the next call sends the array's `assistant_tool_call` lines along.
   */
  cutAfterToolCalls?: boolean;
  /** Append the descriptor's `answerEndHint` to the CLI system prompt. */
  answerEndHint?: boolean;
  /** Send the prompt without its trailing reasoning opener. */
  stripReasoningOpener?: boolean;
  /** Keep a parse repair inside the CLI session (`cli-session-chain`). */
  resumeAcrossRepair?: boolean;
  onNotice?: (message: string) => void;
  /** Test seams; default to the real spawn-backed implementations. */
  runCliImpl?: CliRunner;
  streamCliImpl?: CliStreamRunner;
}

/**
 * Drives an already-signed-in vendor CLI (`claude`, `codex`) as an LLM
 * backend so a flat-rate subscription can power the agent with no API
 * key. The CLI authenticates from its own session — this provider never
 * reads, copies or replays OAuth tokens or keychain entries.
 *
 * Every CLI-specific decision lives in the descriptor; this class only
 * knows how to run a process and shape the result.
 */
export class SubscriptionCliProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * The tools are never forwarded to the CLI (no `tools` payload, no
   * MCP), so the transport it really serves is the text one: the prompt
   * asks for the JSON-array tool call and `parseToolCalls` reads it out
   * of `content`. It used to declare `native_tools` — which made the
   * persona say "never write tool-call JSON as text" to a model that
   * had no other way to call a tool, while Codex's steering text asked
   * for the JSON array. The price is that a format drift now takes the
   * parser's one-shot retry (a second CLI invocation) instead of the
   * native recovery ladder; the gain is a prompt that agrees with the
   * wire. See F32.
   */
  readonly toolCallAdapter: ToolCallAdapter | null = null;
  /** Streaming is owned end to end here; that seam consumes SSE bytes. */
  readonly streamConsumer = null;

  private readonly descriptor: CliAdapterDescriptor;
  private readonly binary: string;
  private readonly cwd: string;
  private readonly model: string;

  /** The CLI's model, when one is set (Codex may leave it empty). */
  get chatModelId(): string | undefined {
    return this.model.length > 0 ? this.model : undefined;
  }
  private readonly extraArgs: readonly string[];
  private readonly streamingEnabled: boolean;
  private readonly maxBudgetUsd: number | undefined;
  private readonly timeoutMs: number;
  /** The descriptor's system prompt, with the answer-end hint when set. */
  private readonly systemPrompt: string;
  private readonly cutAfterToolCalls: boolean;
  private readonly stripReasoningOpener: boolean;
  private readonly resumeAcrossRepair: boolean;
  private readonly onNotice: ((message: string) => void) | undefined;
  private readonly runCli: CliRunner;
  private readonly streamCli: CliStreamRunner;
  /** Last answered call per conversation (`CompletionRequest.sessionId`). */
  private readonly sessions = new Map<string, CliSessionLink>();

  constructor(options: SubscriptionCliProviderOptions) {
    const descriptor = options.descriptor;
    this.id = options.id;
    this.descriptor = descriptor;
    this.name = descriptor.displayName;
    this.binary = resolveCliBinary(descriptor.defaultBinary, options.binPath);
    this.cwd = options.cwd;
    // May be empty: Codex under a ChatGPT login rejects explicit model
    // ids and resolves one itself, so the flag is then omitted.
    this.model = options.model ?? descriptor.defaultChatModel;
    this.extraArgs = options.extraArgs ?? [];
    this.streamingEnabled =
      descriptor.streamMode === "ndjson" && options.streaming !== false;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.systemPrompt =
      options.answerEndHint === true && descriptor.answerEndHint
        ? `${descriptor.systemPrompt} ${descriptor.answerEndHint}`
        : descriptor.systemPrompt;
    this.cutAfterToolCalls = options.cutAfterToolCalls === true;
    this.stripReasoningOpener = options.stripReasoningOpener === true;
    this.resumeAcrossRepair = options.resumeAcrossRepair === true;
    this.onNotice = options.onNotice;
    this.runCli = options.runCliImpl ?? runCliCommand;
    this.streamCli = options.streamCliImpl ?? streamCliCommand;
    this.capabilities = {
      vision: false,
      visionSource: "config-disabled",
      toolTransport: "grammar",
      contextWindow: descriptor.contextWindow,
      supportsParallelTools: false,
      // Every completion is a fresh process; there is no slot to pin.
      supportsSlotAffinity: false,
      // Verified: server-side prompt caching survives across separate
      // invocations, so the KV-stable two-zone prompt still pays off.
      supportsPromptCache: true,
      reasoningFormat: "none",
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let turn = this.planTurn(request);
    for (;;) {
      const system = await this.stageSystemPrompt(turn);
      try {
        const result = await this.completeOnce(request, turn, system.session);
        this.keepTurn(request, turn, result.content);
        return result;
      } catch (err) {
        if (!turn?.resume || !isRefusedResume(err, request)) throw err;
        turn = restartCliSessionTurn(turn, randomUUID);
      } finally {
        await system.cleanup();
      }
    }
  }

  private async completeOnce(
    request: CompletionRequest,
    turn: CliSessionTurn | null,
    session: CliArgsInput["session"],
  ): Promise<CompletionResult> {
    const staged = await this.stageSchema(request);
    try {
      const args = this.descriptor.completeArgs(
        this.argsInput(request, staged.path, session),
      );
      const outcome = await this.runCli(this.runOptions(args, request, turn));
      return this.descriptor.parseResult(outcome.stdout, this.model);
    } finally {
      await staged.cleanup();
    }
  }

  /**
   * Decide whether this call continues a CLI session (`cli-session-chain`).
   * Side calls with a response schema stay stateless. The link is taken
   * out while the call is in flight: a session continues only from its
   * last answered call, so a concurrent or failed one starts a new one.
   */
  private planTurn(request: CompletionRequest): CliSessionTurn | null {
    const key = request.sessionId;
    if (!this.descriptor.resumesSessions || !key || request.responseFormat) {
      return null;
    }
    const turn = planCliSessionTurn(
      this.systemPrompt,
      this.outgoingPrompt(request),
      this.sessions.get(key),
      randomUUID,
      { resumeAcrossRepair: this.resumeAcrossRepair },
    );
    if (turn) this.sessions.delete(key);
    return turn;
  }

  /** The prompt as the CLI gets it (`stripReasoningOpener`). */
  private outgoingPrompt(request: CompletionRequest): string {
    return this.stripReasoningOpener
      ? withoutReasoningOpener(request.prompt)
      : request.prompt;
  }

  /**
   * `answer` is what the CLI's session holds as this call's reply: the
   * result text, or nothing for an answer cut short — the CLI keeps no
   * turn for a process stopped mid-stream.
   */
  private keepTurn(
    request: CompletionRequest,
    turn: CliSessionTurn | null,
    answer: string,
  ): void {
    if (!turn || !request.sessionId) return;
    this.sessions.set(request.sessionId, {
      id: turn.id,
      system: turn.system,
      user: turn.user,
      answer,
      ...(turn.before ? { before: turn.before } : {}),
    });
    if (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
  }

  /**
   * A session's system prompt carries the fixed part of the prompt, far
   * past what argv holds (and past cmd.exe's line limit on a Windows
   * shim), so the CLI reads it from a file.
   */
  private async stageSystemPrompt(turn: CliSessionTurn | null): Promise<{
    session?: NonNullable<CliArgsInput["session"]>;
    cleanup: () => Promise<void>;
  }> {
    if (!turn) return { cleanup: async () => {} };
    const dir = await mkdtemp(join(tmpdir(), "atomic-cli-system-"));
    const path = join(dir, "system.txt");
    await writeFile(path, turn.system, "utf8");
    return {
      session: { id: turn.id, resume: turn.resume, systemPromptFile: path },
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  /**
   * Some CLIs take the structured-output schema inline on argv, others
   * only as a path. Writing that file is a side effect, so it lives here
   * rather than inside the argv builders, which stay pure and testable.
   */
  private async stageSchema(
    request: CompletionRequest,
  ): Promise<{ path?: string; cleanup: () => Promise<void> }> {
    const noop = { cleanup: async () => {} };
    if (this.descriptor.schemaDelivery !== "file" || !request.responseFormat) {
      return noop;
    }
    const dir = await mkdtemp(join(tmpdir(), "atomic-cli-schema-"));
    const path = join(dir, "schema.json");
    await writeFile(
      path,
      JSON.stringify(request.responseFormat.schema),
      "utf8",
    );
    return {
      path,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    if (!this.streamingEnabled) {
      const result = await this.complete(request);
      if (result.content.length > 0) {
        yield { delta: result.content, reasoningDelta: "", done: false };
      }
      yield { delta: "", reasoningDelta: "", done: true };
      return result;
    }

    let turn = this.planTurn(request);
    const progress = { sawDelta: false };
    for (;;) {
      const system = await this.stageSystemPrompt(turn);
      try {
        const { result, cut } = yield* this.streamOnce(
          request,
          turn,
          system.session,
          progress,
        );
        this.keepTurn(request, turn, cut ? "" : result.content);
        return result;
      } catch (err) {
        // Text that already reached the caller cannot be taken back.
        const refused = !progress.sawDelta && isRefusedResume(err, request);
        if (!turn?.resume || !refused) throw err;
        turn = restartCliSessionTurn(turn, randomUUID);
      } finally {
        await system.cleanup();
      }
    }
  }

  private async *streamOnce(
    request: CompletionRequest,
    turn: CliSessionTurn | null,
    session: CliArgsInput["session"],
    progress: { sawDelta: boolean },
  ): AsyncGenerator<
    StreamChunk,
    { result: CompletionResult; cut: boolean },
    void
  > {
    const args = this.descriptor.streamArgs(
      this.argsInput(request, undefined, session),
    );
    const lines = this.streamCli(this.runOptions(args, request, turn));
    let final: string | null = null;
    let rateLimits: readonly RateLimitWindow[] | undefined;
    // Not for a schema call: its answer is an object, never an array.
    const cut =
      this.cutAfterToolCalls && !request.responseFormat
        ? new ToolCallArrayCut()
        : null;
    let start: StartUsage | null = null;
    const startedAt = Date.now();

    for await (const line of lines) {
      const event = this.descriptor.parseStreamEvent(line);
      if (event.kind === "delta") {
        progress.sawDelta = true;
        const kept = cut ? cut.push(event.text) : null;
        if (cut && kept !== null) {
          // Leaving the loop ends the line iterator, whose `finally`
          // stops the CLI's whole process tree.
          if (kept.length > 0) {
            yield { delta: kept, reasoningDelta: "", done: false };
          }
          this.onNotice?.(
            `${this.descriptor.cli} answer cut after its tool-call array ` +
              `(${cut.answer.length} of ${cut.received}+ chars kept)`,
          );
          const result = cutResult(
            cut,
            start,
            this.model,
            Date.now() - startedAt,
            rateLimits,
          );
          yield { delta: "", reasoningDelta: "", done: true };
          return { result, cut: true };
        }
        yield { delta: event.text, reasoningDelta: "", done: false };
      } else if (event.kind === "start") {
        start = event.usage;
      } else if (event.kind === "final") {
        final = event.raw;
      } else if (event.kind === "notice") {
        this.onNotice?.(event.message);
      } else if (event.kind === "rate_limit") {
        rateLimits = mergeWindows(rateLimits, event.windows);
        if (event.notice) this.onNotice?.(event.notice);
      }
    }

    if (final === null) {
      throw new Error(`${this.binary} stream ended without a result envelope`);
    }
    const parsed = this.descriptor.parseResult(final, this.model);
    const result: CompletionResult =
      rateLimits === undefined
        ? parsed
        : { ...parsed, rateLimits: mergeWindows(parsed.rateLimits, rateLimits) };
    // Safety net for a stream schema we do not control: if no delta was
    // recognised, emit the authoritative text once so a mismatch
    // degrades to buffered behaviour instead of an empty turn.
    if (!progress.sawDelta && result.content.length > 0) {
      yield { delta: result.content, reasoningDelta: "", done: false };
    }
    yield { delta: "", reasoningDelta: "", done: true };
    return { result, cut: false };
  }

  async describeImage(_request: VisionRequest): Promise<VisionResult> {
    throw new VisionUnsupportedError(this.id);
  }

  async health(): Promise<ProviderHealthResult> {
    const started = Date.now();
    try {
      await this.runCli({
        binary: this.binary,
        args: this.descriptor.healthArgs(),
        cwd: this.cwd,
        timeoutMs: HEALTH_TIMEOUT_MS,
        maxOutputBytes: MAX_HEALTH_BYTES,
        installHint: this.descriptor.installHint,
        authHint: this.descriptor.authHint,
        productName: this.descriptor.productName,
        stripEnv: this.descriptor.billingEnvKeys,
      });
      return {
        reachable: true,
        status: null,
        error: null,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  async listModels(): Promise<readonly string[]> {
    // Curated list, no probe: the CLI exposes no model-list command.
    return this.descriptor.staticModels;
  }

  async close(): Promise<void> {
    // Every invocation is its own short-lived process. The CLI's sessions
    // stay on disk with the CLI; only the links to them are dropped.
    this.sessions.clear();
  }

  private argsInput(
    request: CompletionRequest,
    schemaPath?: string,
    session?: CliArgsInput["session"],
  ): CliArgsInput {
    const delivery = this.descriptor.schemaDelivery;
    return {
      model: this.model,
      systemPrompt: this.systemPrompt,
      ...(request.responseFormat && delivery === "inline"
        ? { responseSchema: request.responseFormat.schema }
        : {}),
      ...(schemaPath ? { responseSchemaPath: schemaPath } : {}),
      ...(this.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: this.maxBudgetUsd }),
      extraArgs: this.extraArgs,
      ...(session ? { session } : {}),
    };
  }

  private runOptions(
    args: readonly string[],
    request: CompletionRequest,
    turn: CliSessionTurn | null,
  ) {
    return {
      binary: this.binary,
      args,
      // The prompt goes on stdin, never argv: a two-zone prompt routinely
      // exceeds the 128 KiB single-argument limit once the conversation
      // zone fills, and argv delivery would fail with E2BIG on exactly
      // the long sessions that matter most.
      input: this.descriptor.buildStdin(
        turn ? turn.input : this.outgoingPrompt(request),
        this.systemPrompt,
      ),
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_COMPLETION_BYTES,
      installHint: this.descriptor.installHint,
      authHint: this.descriptor.authHint,
      productName: this.descriptor.productName,
      stripEnv: this.descriptor.billingEnvKeys,
      ...(request.signal ? { signal: request.signal } : {}),
    };
  }
}

/**
 * The CLI itself turned a resumed call down (its session file is gone,
 * or it no longer takes it): worth one more try as a new session. A
 * cancelled call is not.
 */
function isRefusedResume(err: unknown, request: CompletionRequest): boolean {
  return (
    err instanceof SubscriptionCliInvocationError && !request.signal?.aborted
  );
}

/**
 * Newer readings replace older ones of the same window; a window the
 * newer batch does not mention keeps its last reading (the CLI reports
 * one window per `rate_limit_event`).
 */
function mergeWindows(
  older: readonly RateLimitWindow[] | undefined,
  newer: readonly RateLimitWindow[],
): readonly RateLimitWindow[] {
  if (!older || older.length === 0) return newer;
  const key = (w: RateLimitWindow) => `${w.scope}/${w.name}`;
  const fresh = new Set(newer.map(key));
  return [...older.filter((w) => !fresh.has(key(w))), ...newer];
}

type StartUsage = Extract<CliStreamEvent, { kind: "start" }>["usage"];

/**
 * The result of an answer stopped at its array: the CLI never sends its
 * envelope, so the prompt side comes from the stream's start event and the
 * output side is an estimate from the characters received (Claude's
 * answers here run near two characters per token).
 */
function cutResult(
  cut: ToolCallArrayCut,
  start: StartUsage | null,
  model: string,
  predictedMs: number,
  rateLimits: readonly RateLimitWindow[] | undefined,
): CompletionResult {
  const promptTokens = start
    ? start.inputTokens + start.cacheCreationTokens + start.cacheReadTokens
    : 0;
  const completionTokens = Math.ceil(cut.received / CUT_CHARS_PER_TOKEN);
  return {
    content: cut.answer,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs,
      promptTokens,
      predictedTokens: completionTokens,
    },
    cacheHitTokens: start?.cacheReadTokens ?? 0,
    slotId: -1,
    modelId: model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    finishReason: "stop",
    ...(rateLimits ? { rateLimits } : {}),
  };
}
