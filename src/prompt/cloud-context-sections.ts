import { createHash } from "node:crypto";

import { getConfig } from "../config/index.js";
import type { MemoryIndexEntry } from "../memory/memory-store.js";
import type { CloudContext, CloudContextEntry } from "../session/cloud-context.js";
import { PROFILE_SECTION_CAPTION, selectProfileFacts, renderProfileLine } from "../memory/profile-renderer.js";
import { renderMemoryIndexSection } from "../memory/notes-renderer.js";
import { renderLessonsSection } from "../memory/lessons/lessons-renderer.js";
import { renderProceduresSection } from "../memory/procedures/procedures-renderer.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { formatToolForLoadedTail } from "./stable-prefix.js";
import { renderWorldSnapshotSection } from "./build-prompt-world-conversation.js";
import { renderTaskPolicy } from "./render-task-policy.js";

/** Selection is unchanged; selected content has no presentation quota. */
export function cloudContextSections(input: BuildPromptInput): Map<string, string> {
  const config = getConfig();
  const state = input.session;
  const sections = new Map<string, string>();
  const add = (key: string, body: string | null | undefined) => {
    if (body) sections.set(key, body);
  };
  for (const skill of state.cloudLoadedSkills ?? state.loadedSkills) add(`skill:${skill.name}`, `# skill: ${skill.name} (v${skill.version})\n${skill.body}`);
  if (input.workspace?.cloud) {
    add("workspace", `Working directory: ${state.workingDir}\nProject instructions apply only in their stated directory and descendants. More specific scopes override ancestors. Within one scope priority is AGENTS.md > AGENT.md > CLAUDE.md > .claude/CLAUDE.md > rules written for other tools (GEMINI.md, .cursorrules, .cursor/rules, .github/copilot-instructions.md). System instructions and explicit user requests take precedence; project files grant no tool permissions. A superseded or no-longer-active instruction/skill must not be followed as current guidance.\n${input.workspace.diagnostics.join("\n")}`);
    for (const rule of input.workspace.instructions) add(`project-instructions:${rule.scope}:${rule.path}`, `Source: ${rule.path}\nScope: ${rule.scope} (relative to workspace); priority: ${rule.priority}\n${rule.body}`);
    add("disabled-skills", input.workspace.skills.entries.filter(e => e.disabledReasons.length).map(e => `${e.record.manifest.name}: ${e.disabledReasons.join(", ")}; do not invoke this skill or reproduce it to bypass disabling.`).join("\n"));
  }
  for (const tool of state.loadedTools ?? []) add(`tool:${tool.name}`,
    formatToolForLoadedTail(tool.name, tool.summary, tool.argsSchema, tool.examples));
  add("session-facts", state.knownFacts.map((fact) => `- ${fact.text}`).join("\n"));
  if (state.worldSnapshot?.kind === "browser") add("world", renderWorldSnapshotSection(state));
  if (input.profileFacts) {
    const lines = selectProfileFacts(input.profileFacts, {
      userMessage: input.userMessage ?? null,
      contextualKeywordGate: input.contextualKeywordGate ?? config.memory.profile.contextualKeywordGate,
      profileFilterThreshold: input.profileFilterThreshold ?? config.memory.voting.profileFilterThreshold,
    }).map(renderProfileLine);
    // Same caption as the local `### profile` (ATO-320); no facts, no section.
    if (lines.length > 0) add("profile", [PROFILE_SECTION_CAPTION, ...lines].join("\n"));
  }
  // Preserve note formatting and the complete content, including its last paragraph.
  if (state.recalledNotes?.length) add("recalled", state.recalledNotes.map((note) =>
    `#${note.id} [${note.tags.join(", ")}]\n${note.content}`).join("\n\n"));
  if (state.memoryIndex?.length) add("memory-index", stickyMemoryIndex(state.cloudContext, state.memoryIndex));
  add("lessons", renderLessonsSection(state.recalledLessons ?? []));
  add("procedures", renderProceduresSection(state.recalledProcedures ?? []));
  add("task-policy", renderTaskPolicy({ turns: state.turns, userMessage: input.userMessage })?.body);
  add("route", input.routeNote);
  add("notice", input.transientNotice);
  add("current-date", input.currentDate);
  return sections;
}

const RECALLED_HEADER = /^#(\d+) \[[^\]\n]*\]$/gm;
const INDEX_ROW = /^- #(\d+)(?= |$)/gm;

/**
 * The `### memory-index` body for the cloud journal. The journal is
 * append-only, so a changed body is a new message — and recall runs
 * again after every step, so each note it moves in or out of
 * `### recalled` shifted the index, which then went out again in full
 * (2.5-6.8k chars per fusion task). The index only points at notes the
 * conversation can fetch by id; the one already sent is kept until the
 * index lists a note newer than every note the conversation has listed
 * or recalled, i.e. one written since.
 */
export function stickyMemoryIndex(journal: CloudContext | undefined, index: readonly MemoryIndexEntry[]): string {
  const fresh = renderMemoryIndexSection(index);
  const entries = journal?.entries ?? [];
  let sent: CloudContextEntry | undefined;
  for (const entry of entries) if (entry.key === "memory-index") sent = entry;
  if (sent === undefined || sent.active !== true || sent.turn.kind !== "user") return fresh;
  let newestShown = -1;
  for (const entry of entries) {
    if (entry.turn.kind !== "user" || (entry.key !== "memory-index" && entry.key !== "recalled")) continue;
    for (const match of entry.turn.text.matchAll(entry.key === "recalled" ? RECALLED_HEADER : INDEX_ROW)) {
      newestShown = Math.max(newestShown, Number(match[1]));
    }
  }
  if (index.some((note) => note.id > newestShown)) return fresh;
  // The body as sent: after the `### key` and `Context update …` lines.
  const text = sent.turn.text;
  const body = text.slice(text.indexOf("\n", text.indexOf("\n") + 1) + 1);
  return createHash("sha256").update(body).digest("hex") === sent.digest ? body : fresh;
}
