const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * The prompt for a text-transport profile ends with the local model's
 * reasoning opener (`<think>`, or the empty `<think></think>` block under
 * `thinking: off`). A vendor CLI's model is not that model: for it the tag
 * is the last line of a transcript to continue. With
 * `subscriptionCli.stripReasoningOpener` the provider sends the prompt
 * without it, ending in exactly one newline; the prompt the agent built,
 * and how the answer is parsed, stay as they are.
 */
export function withoutReasoningOpener(prompt: string): string {
  let body = prompt.trimEnd();
  if (body.endsWith(CLOSE_TAG)) {
    const inner = body.slice(0, body.length - CLOSE_TAG.length).trimEnd();
    if (!inner.endsWith(OPEN_TAG)) return prompt;
    body = inner;
  }
  if (!body.endsWith(OPEN_TAG)) return prompt;
  return `${body.slice(0, body.length - OPEN_TAG.length).trimEnd()}\n`;
}
