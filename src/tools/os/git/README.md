# Git tools and remote credentials

Status: current
Owner: src/tools/os/git/

Git read and remote-mutation operations have different resource/approval classes. Preserve subprocess argument handling, host/path validation, credential headers and scope of destructive operations. Credentials must not persist in remote URLs or tool summaries.

Read [tool instructions](../../AGENTS.md), [Git API helpers](../../../github/README.md), [git registry](index.ts), and adjacent git tests. Remote fetch/pull/push/clone behavior must be checked separately from read-only status/diff/log.

[Diff](git-diff.ts): a working-tree diff (no `revisionRange`, not `staged`) appends untracked files as new-file diffs (`git diff --no-index /dev/null <file>`, `paths` respected, at most 50 files, the rest counted in `details.untrackedOmitted`). A review of fresh work, where every file is still `??`, otherwise sees "(no diff)" and never reads the code. Staged and revision diffs keep plain git semantics.
