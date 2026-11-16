import { createHash } from "node:crypto";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { describeArgsShape } from "./shell-interpretation.js";

/**
 * `os.shell.run`'s `stdin`: text written to the command's input, which is
 * then closed (`startCommandJob`).
 *
 * Live (k8e, 16-11-2026) the core worker wrote a test file to drive its
 * own code — the command had no input, so a script had to be a file —
 * and the judge read the file as work outside its task and sent the task
 * back; the retry ran out the ten-minute clock. With `stdin`,
 * `{cmd: "python", args: ["-"], stdin: "<script>"}` runs the script in
 * the working directory, so the worker's modules import, and leaves no
 * file behind.
 *
 * A script on stdin is checked as the same call with the code on the
 * line (`stdinAsInlineScript`): the guard, the dangerous layer, saved
 * rules and the browser check read `python -c <script>`, never a bare
 * interpreter. A subshell line, a wrapper in front of an interpreter, and
 * a program that runs its input as commands no check reads are refused
 * (`stdinFeedsUnreadCommands`).
 */

/** At most this many UTF-8 bytes go to a command's input. */
export const SHELL_STDIN_MAX_BYTES = 16_384;

export interface ShellStdin {
  text: string;
  bytes: number;
  /** The first 8 hex digits of its SHA-256: tells two scripts apart in a record, never shows them. */
  digest: string;
}

/**
 * The call's `stdin`: `null` when there is none (omitted, `null`, or
 * blank — zero-filling models send `""`), an error message when it is
 * not a string or is too large.
 */
export function parseShellStdin(value: unknown): ShellStdin | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return {
      error:
        "os.shell.run: `stdin` must be a string (got " +
        describeArgsShape(value) +
        "): the text written to the command's input, e.g. {\"cmd\":\"python\",\"args\":[\"-\"],\"stdin\":\"print(1)\"}.",
    };
  }
  if (value.trim().length === 0) return null;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > SHELL_STDIN_MAX_BYTES) {
    return {
      error: `os.shell.run: \`stdin\` is ${bytes} bytes; at most ${SHELL_STDIN_MAX_BYTES} go to a command's input. Split the script, or write it to a file your task owns and run that.`,
    };
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
  return { text: value, bytes, digest };
}

/** Refused before the guard: a subshell line reads its input from the line itself. */
export const STDIN_WITH_SUBSHELL_MESSAGE =
  "os.shell.run: `stdin` goes with the structured form `{cmd, args}`; a command line run through the subshell takes its input from the line itself (`<`, a pipe). Pass the program in `cmd` and its arguments in `args`.";

/** Refused before the guard: what the input would run is read by no check. */
export function stdinUnreadMessage(cmd: string): string {
  return `os.shell.run: \`stdin\` given to \`${cmd}\` would run as commands no check reads (a wrapper in front of an interpreter, \`xargs\`, \`cmd\` or \`powershell\`). Name the interpreter itself, e.g. {"cmd":"python","args":["-"],"stdin":"…"}.`;
}

/** The error result for a refused `stdin`. Nothing ran. */
export function refuseShellStdin(cmd: string, message: string): CompressedToolResult {
  return compressToolResult({
    tool: "os.shell.run",
    status: "error",
    output: message,
    details: { cmd, stdinRefused: true },
  });
}

/** What the approval prompt shows under the command line: the input in full. */
export function formatStdinPreview(stdin: ShellStdin): string {
  return `\nstdin (${stdin.bytes} bytes):\n${stdin.text}`;
}
