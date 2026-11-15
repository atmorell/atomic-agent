import type { ToolDescriptor } from "./stable-prefix.js";
import { fusionDelegateAutoVerifyArgsJsonSchema } from "./default-tool-args-schemas.js";

/**
 * Autoverify (lever F1, `llm.runMode.fusion.autoVerify`): the one
 * sentence `fusion.delegate`'s description gains while the flag is on.
 */
export const AUTOVERIFY_DELEGATE_SENTENCE =
  "Pass the task's test command as `verify`; call verify.run only when the delegate result is not a pass.";

/** The `verify` entry the args sketch gains, placed before `resume`. */
const AUTOVERIFY_ARGS_ENTRY =
  "verify?: { ...verify.run args } /* run after the workers; a failure goes back to a local repair */, ";

/**
 * The flag-on `fusion.delegate` descriptor: the sentence above on both
 * the full and the compact summary, `verify` in the args sketch and in
 * the JSON schema. Any other descriptor is returned as is, so the
 * flag-off catalog is never touched.
 */
export function withAutoVerifyDelegate(descriptor: ToolDescriptor): ToolDescriptor {
  if (descriptor.name !== "fusion.delegate") return descriptor;
  const at = descriptor.argsSchema.indexOf("resume?:");
  const argsSchema =
    at < 0
      ? descriptor.argsSchema
      : `${descriptor.argsSchema.slice(0, at)}${AUTOVERIFY_ARGS_ENTRY}${descriptor.argsSchema.slice(at)}`;
  return {
    ...descriptor,
    summary: `${descriptor.summary} ${AUTOVERIFY_DELEGATE_SENTENCE}`,
    argsSchema,
    argsJsonSchema: fusionDelegateAutoVerifyArgsJsonSchema(),
    ...(descriptor.compact === undefined
      ? {}
      : {
          compact: {
            ...descriptor.compact,
            summary: `${descriptor.compact.summary} ${AUTOVERIFY_DELEGATE_SENTENCE}`,
          },
        }),
  };
}
