# Design Specification: Universal Artifact Review UI

## 1. Executive Summary
A VS Code extension designed to decouple the "Artifact -> Inline Comment -> Update -> Approve" workflow from specific ecosystems like Google Antigravity. By acting as an agnostic orchestration layer, it enables users to iteratively co-steer the generation of files (Markdown, Code, Configs) using any CLI-based AI agent (Claude Code, Local LLMs, Antigravity).

The system relies on a **File-as-Interchange** architecture. It avoids brittle process-hacking by using the local file system as the single source of truth, passing context to native CLI tools via structured `.review.md` sidecar files.

## 2. System Architecture

This workflow illustrates the decoupling between the VS Code Extension UI and the underlying AI CLI processes:

1. **User Interaction**: User highlights text in VS Code UI and adds an inline comment.
2. **Extension Write**: VS Code Extension writes to a `.review.md` Sidecar file.
3. **CLI Agent Read**: CLI Agent (Claude Code / Local AI) reads the original file and the Sidecar file.
4. **CLI Agent Write**: CLI Agent modifies the original file and writes back to disk.
5. **UI Update**: VS Code FileSystemWatcher detects the change and updates the UI Virtual Document.

## 3. Core User Flow

1. **Generation:** The user prompts an AI agent via its native CLI (or an extension-provided shortcut) to generate a file.
2. **Detection:** The extension's `FileSystemWatcher` detects the file creation/modification by an external process and flags it as "In Review".
3. **Review:** The user opens the file from the custom Activity Bar panel. The file opens as a read-only Virtual Document.
4. **Inline Co-Steering:** The user highlights specific lines, invokes the VS Code comment UI, and types feedback.
5. **Interchange:** The extension parses the comment, extracts the target code snippet, and writes an "Anchored Block" to a `.review.md` sidecar file.
6. **Agent Update:** The user triggers the CLI agent to read the sidecar file and apply the changes. The agent overwrites the original file.
7. **Verification:** The Virtual Document updates. The user views the native VS Code diff to verify the agent's work.
8. **Approval & Execution:** The user clicks "Approve". The virtual document state is finalized. If the file is a `.md` plan, the user can optionally pipe it into a new AI task as the system prompt.

## 4. The Data Schema (The Anchored Block)

To solve the "Context Drift" problem, the extension must format all comments into a strict, machine-readable schema inside the `[filename].review.md` sidecar file.

The sidecar is the **single source of truth** shared by both humans and agents. Humans add
comments through the VS Code gutter; agents read and edit the sidecar directly. The editor's
inline review threads are a live projection of this file — see §5.1.

```markdown
# Pending Review Comments for `[filename]`

<review_item id="[stable-id]" status="pending">
<location>
File: `[filename]`
Lines: [StartLine]-[EndLine]
</location>

<target_code>
```[language]
[Exact string content extracted via VS Code Document API]
```
</target_code>

<comment author="You">
[The user's raw comment text]
</comment>

<comment author="Agent">
[An optional agent reply on the same thread]
</comment>
</review_item>
```

* **`id`** — a stable identifier the extension uses to match a block to its live gutter
  thread across edits. Human-added blocks always carry one. If an agent adds a block without
  an `id`, the extension synthesizes a deterministic one from the block's contents.
* **`status`** — `pending` or `resolved`. Drives the native thread resolution state (§5.1).
* **`<comment author="...">`** — one entry per comment in the thread, in order. `author` is
  the display name (`You` for the user, e.g. `Agent` for the agent). A legacy single
  `<user_feedback>` block is still parsed (treated as one `You` comment) for back-compat.

**Agent Prompting Standard:**
When executing an iteration, the CLI agent must be prompted with the instruction:
*"Read the `.review.md` file. Use the `<target_code>` blocks to locate the exact sections in
the primary file that require modification. Apply each pending `<comment>` and output the
complete updated file. When a review item is addressed, set its `status` to `resolved`; you
may also append a `<comment author=\"Agent\">` explaining what you changed. Preserve each
review item's `id`. To raise a new point, add a `<review_item>` (a fresh `id` is optional)."*

## 5. VS Code API Mapping

The extension will strictly utilize native VS Code APIs to prevent UI bloat and ensure it feels like a built-in feature.

* **Artifact Picker:** `vscode.window.createTreeView` - Renders a custom sidebar menu showing pending, iterating, and approved files.
* **Sandbox Environment:** `vscode.workspace.registerTextDocumentContentProvider` - Generates the read-only `ai-review://` URI documents so users don't accidentally overwrite the disk state manually.
* **Inline Commenting:** `vscode.comments.createCommentController` - Provides the native "Google Doc" style commenting UI in the editor gutter.
* **State Tracking:** `vscode.workspace.createFileSystemWatcher` - Listens for file changes in the workspace to know when the CLI agent has finished an iteration.
* **Diffing:** `vscode.commands.executeCommand('vscode.diff', ...)` - Triggers the native split-pane visual diff between the pre-iteration and post-iteration file states.

### 5.1 Sidecar ↔ Thread synchronization

Inline threads are a **projection of the sidecar**, reconciled by id:

* **Render:** On opening an `ai-review://` document, and whenever its sidecar changes, the
  extension parses every `<review_item>` and creates/updates one `CommentThread` per block,
  keyed by `id`. Each thread's comments are rebuilt from the block's `<comment>` entries.
* **Resolution mapping:** A block's `status` drives `vscode.CommentThread.state` —
  `resolved` → `CommentThreadState.Resolved` (collapsed, checkmark), `pending` →
  `Unresolved`. So when an agent flips a block to `resolved`, the gutter thread resolves
  itself with no user action.
* **Human input:** Commenting on a new range appends a `<review_item>` (with a fresh `id`);
  replying to an existing thread appends a `<comment>` to that item. Either way the sidecar
  is rewritten and the gutter re-rendered.
* **Removal:** A thread whose `id` no longer appears in the sidecar is disposed; deleting the
  sidecar (on approval) disposes all of that artifact's threads.

## 6. Execution & Handoff (Post-Approval)

Once an artifact is approved, the extension must support workflow chaining.

* **Clean Up:** The extension deletes the `.review.md` sidecar file.
* **Commit:** If working on a virtual document, the final state is committed to the physical workspace disk (`vscode.workspace.fs.writeFile`).
* **Trigger Subsequent Action:** For Tier 1 files (Markdown plans, architectures, task lists), the extension UI will prompt: *"Artifact Approved. Run as prompt?"*
* **Pipeline:** If accepted, the extension concatenates a standard prompt prefix (e.g., *"Execute the following approved plan:"*) with the Markdown file contents, and passes it to the CLI agent via `stdin` or standard CLI arguments.

## 7. Development Phases

### Phase 1: The Core Loop (Local Mocking)
* Build the `TreeView` Artifact Picker.
* Implement the `TextDocumentContentProvider` for read-only viewing.
* Implement the `CommentController` to capture highlighted text and write the `<review_item>` XML to a local `.review.md` file.
* *Testing:* Manually edit the file to simulate an AI agent and ensure the `FileSystemWatcher` picks up the changes.

### Phase 2: Agent Integration
* Build the "Iterate" trigger that executes a local CLI command (e.g., Ollama or a custom shell script wrapping Claude Code).
* Implement the `vscode.diff` comparison viewer.
* Map the "Resolved" status in the sidecar file to the native VS Code comment thread resolution state.

### Phase 3: Polish & Handoff
* Add syntax highlighting and markdown preview support for the `ai-review://` scheme.
* Build the "Approve -> Trigger Subsequent AI Action" pipeline.
