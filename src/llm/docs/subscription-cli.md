# Subscription CLI answer-shape flags

Status: current
Owner: src/llm/

A `subscription-cli` provider drives a signed-in vendor CLI (`claude --print`) and keeps a session on the CLI's side: the first call names it, later calls resume it and send only the new text ([cli-session-chain.ts](../provider/subscription-cli/cli-session-chain.ts)). The prompt it receives is the agent's text transcript, so the model sometimes keeps writing that transcript after its tool-call array — an invented tool result or the next user turn. The parser ignores that text, but it costs output tokens and is written to the CLI's cache on the next call.

Four flags under the provider entry's `subscriptionCli` block shape this. All default to off; with all off the provider sends exactly what it sent before.

| Key | Effect |
|---|---|
| `cutAfterToolCalls` | Streaming only, not for a schema call. When the answer opens with a complete, valid tool-call array (`[{"tool": ...}]`) and a non-space character follows, the provider stops the CLI there ([tool-call-array-cut.ts](../provider/subscription-cli/tool-call-array-cut.ts)). The result holds the array; prompt usage comes from the stream's `message_start`, output tokens are estimated (2 chars/token). The CLI keeps no turn for a stopped process, so the next call resumes the same session and sends the array's `assistant_tool_call` lines along with the new text. |
| `answerEndHint` | Appends the adapter's `answerEndHint` (Claude: the answer ends at the array's closing bracket; the prompt's conversation is a record, not a transcript to continue) to the CLI system prompt. The stable prefix changes once, then stays byte-stable. |
| `stripReasoningOpener` | Sends the prompt without its trailing `<think>` (or empty `<think></think>`) opener, ending in one newline ([strip-reasoning-opener.ts](../provider/subscription-cli/strip-reasoning-opener.ts)). The agent's prompt, grammar and stream parsing are unchanged: the opener is a local-model framing the vendor model never continues. |
| `resumeAcrossRepair` | Keeps a parse repair inside the resumed CLI session instead of opening a new one. A repair notice that follows the previous answer is sent as a side turn; the call after it continues from the conversation before the repair. A byte-identical re-send (the repair notice lost upstream) resumes with a short `tool-call-repair` notice instead of re-sending the whole prompt. |

Enable in `config.json` on the provider entry, for example `"subscriptionCli": { "cli": "claude", "cutAfterToolCalls": true }`. A cut answer is logged as `llm.subscription_cli` with the kept and received character counts.
