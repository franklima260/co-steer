# Co-Steer — Code Review & Improvement Report

_Reviewed: 2026-06-16 · against `universal_artifact_review_ui_spec.md`, `Testing_Standards.md`, `Telemetry_Standards.md`_

## Summary

A solid Phase-1 skeleton is in place: tree view, read-only `ai-review://` document
provider, native comment controller writing the anchored `<review_item>` schema,
a file-system watcher, and a structured logger. Type-checking passes cleanly and
each component has at least one test.

However, there are **two correctness bugs that break the core flow on Windows**, the
**diff feature is structurally a no-op**, and several spec/standards gaps. Details below,
ranked by severity.

---

## P0 — Breaks the core flow

### 1. `ai-review://` URI is built with `Uri.parse()` on a raw Windows path
`src/extension.ts:95` and `src/providers/ArtifactTreeProvider.ts:37` do:
```ts
vscode.Uri.parse(`ai-review://${originalFilePath}`)
```
`originalFilePath` is an OS path like `C:\Users\Frank\...\file.md`. Parsing
`ai-review://C:\Users\...` treats `C` as the authority and chokes on backslashes —
the resulting `fsPath` will not round-trip to the real file. The provider then reports
"File not found", so **opening an artifact and diffing fail on Windows**.

**Why the tests don't catch it:** `reviewDocument.test.ts` builds the URI the *correct*
way — `Uri.file(path).with({ scheme })` — so the test exercises a different code path
than production. The bug lives only in the un-tested production lines.

**Fix:** build the URI from the file URI everywhere:
```ts
const reviewUri = vscode.Uri.file(originalFilePath).with({ scheme: ReviewDocumentProvider.scheme });
```
…and add a test asserting `reviewUri.fsPath === originalFilePath` to lock it in.

### 2. The diff compares a file against itself — always empty
`co-steer.diff` (`extension.ts:97`) diffs `file://<path>` against `ai-review://<path>`,
but the provider reads `ai-review://` content straight from the **same** file on disk
(`ReviewDocumentProvider.provideTextDocumentContent` → `fs.readFile(uri.fsPath)`). Both
sides are identical, so the diff is always blank.

The spec (§3.7, §5) wants **pre-iteration vs post-iteration**. There is currently no
snapshot of the pre-iteration state to diff against.

**Fix:** snapshot the file content before `co-steer.iterate` runs the agent (e.g. cache
it keyed by path, or write a `.preiterate` copy), and have the provider serve that
snapshot for the diff's left-hand side.

---

## P1 — Repo hygiene / will bite immediately

### 3. Nothing is committed and there is no `.gitignore`
`git ls-files` returns 0 — the "Initial commit" is empty and every file is untracked,
including `node_modules/`, `dist/`, `out/`, and `.vscode-test/`. The first `git add -A`
will commit tens of thousands of dependency files.

**Fix:** add a `.gitignore` (`node_modules/`, `dist/`, `out/`, `.vscode-test/`,
`*.vsix`) before the first real commit.

### 4. `co-steer.agentCommand` is read but never declared
`extension.ts:65` reads `config.get('agentCommand')`, but there is no
`contributes.configuration` block in `package.json`. The setting is invisible in the
Settings UI and always returns `undefined`, so iteration silently falls back to the
`echo` mock — the agent never actually runs.

**Fix:** declare the setting under `contributes.configuration` with a description and
default.

---

## P2 — Security & robustness

### 5. Command injection in `co-steer.iterate`
`extension.ts:67`:
```ts
child_process.exec(`${agentCommand} "${filePath}"`, ...)
```
Both `agentCommand` (user config) and `filePath` are interpolated into a shell string.
A path containing `"` or `$(...)` / backticks can break out. Prefer
`child_process.execFile(agentCommand, [filePath])` (no shell), or at minimum validate
and quote-escape the path.

### 6. "Run as prompt" handoff is a no-op
`co-steer.approve` (`extension.ts:128-135`) prompts "Run as prompt?" and, on Yes, only
shows an info message — it never concatenates the prefix or pipes to the agent. This is
Phase 3 work (acknowledged as incomplete), but the UI currently implies an action that
doesn't happen.

### 7. Approve never commits the virtual document to disk
Spec §6 says approval should finalize the virtual document state to the physical file.
`approve` only deletes the sidecar. Fine if the agent always writes to disk directly,
but worth confirming against the intended model.

### 8. Overly broad physical-file watcher
`createFileSystemWatcher('**/*')` (`extension.ts:36`) fires on **every** file change in
the workspace and calls `reviewDocumentProvider.update` for each. On a large repo this is
noisy and wasteful. Scope it to the artifact types you actually review, or debounce.

### 9. `logger.loggedLines` grows unbounded
`utils/logger.ts:6` keeps every line forever for test introspection — a slow memory leak
in a long-running extension host. Cap it (ring buffer) or gate it behind a test-only flag.

---

## P3 — Spec & standards gaps

- **Tree item state is hardcoded `'In Review'`** (`ArtifactTreeProvider.ts:62`). Spec §5
  calls for pending / iterating / approved states. No state machine exists yet.
- **Comment is added to the thread before the range is validated**
  (`CommentController.ts:32` vs the `!thread.range` guard at `:39`) — on the no-range
  path a comment is shown but no sidecar is written, leaving inconsistent UI state.
- **`activationEvents: []`** — relies entirely on implicit activation from the contributed
  view/commands. Works on modern VS Code, but worth an explicit `onView:co-steer-artifacts`
  for clarity.
- **Sidecar "resolved" status mapping** (Phase 2) and comment-thread resolution are not
  yet wired up.

---

## Testing standards compliance

The standards in `Testing_Standards.md` are good; the suite partially meets them:

- ✅ Uses `@vscode/test-electron`, `test-fixtures`, real workspace, teardown cleanup.
- ⚠️ **`commands.test.ts:31` uses `setTimeout(500)`** — explicitly banned (§3.4). It also
  masks that `approve` is `await`ed and the unlink already completed; the sleep is both
  forbidden and unnecessary.
- ⚠️ **Coverage gaps vs §2.2** ("every command must have a test"): only `approve` is
  exercised end-to-end. No tests for `iterate`, `diff`, or `addComment`'s no-range/error
  branches. The P0 URI bug exists precisely in this gap.
- ⚠️ Assertions use substring `.includes()` rather than asserting exact structure of the
  generated `<review_item>` block — a malformed-but-contains-the-string output would pass.

---

## Recommended order of work

1. Fix the URI construction (P0 #1) + add a round-trip test.
2. Add `.gitignore`, then make the first real commit (P1 #3).
3. Declare `agentCommand` config + switch `exec`→`execFile` (P1 #4, P2 #5).
4. Implement a real pre/post snapshot so diff works (P0 #2).
5. Replace the `setTimeout` test and add command tests for `iterate`/`diff`/`addComment`.
6. Then proceed to Phase 2/3 (resolved-status mapping, real handoff pipeline).
