# Co-Steer

Universal Artifact Review and Co-Steering for VS Code.

Co-Steer decouples the **Artifact → Inline Comment → Update → Approve** workflow from any
single AI ecosystem. It uses the local file system as the single source of truth: your
comments are written to structured `.review.md` sidecar files that any CLI agent
(Claude Code, a local LLM, etc.) can read and act on. See `universal_artifact_review_ui_spec.md`
in the repository for the full design.

## How it works

1. An AI agent generates a file in your workspace.
2. You create a `<file>.review.md` sidecar (by commenting, below) to flag it for review.
   It appears in the **Co-Steer** sidebar with its review state.
3. Open the artifact — it opens as a read-only `ai-review://` virtual document.
4. Highlight lines and add an inline comment. Co-Steer writes a structured
   `<review_item>` block to the sidecar.
5. **Iterate**: Co-Steer snapshots the file, then runs your configured agent on it.
6. **Diff**: view a real before ↔ after diff of the agent's changes.
7. **Approve**: the sidecar is deleted; for Markdown plans you can hand the approved
   content straight to the agent as a prompt.

## Commands

| Command | Description |
|---|---|
| `co-steer.reviewFile` | Start reviewing a file (rendered panel for markdown, text view otherwise) |
| `co-steer.copyPrompt` | Copy an instruction (read the sidecar, apply feedback, resolve) to paste into a chat agent |
| `co-steer.addComment` | Write the highlighted range + feedback to the sidecar |
| `co-steer.iterate` | Snapshot the artifact and run the configured CLI agent, piping it the review prompt |
| `co-steer.diff` | Show the pre-iteration ↔ current diff |
| `co-steer.approve` | Delete the sidecar; optionally run an approved `.md` as a prompt |

> **Comments live in a `<file>.review.md` sidecar, not in the file itself.** To have an AI
> act on them, either run **Iterate** (for a configured CLI agent) or **Copy Agent Prompt**
> and paste it into a chat agent — both point the agent at the sidecar.

## Settings

| Setting | Default | Description |
|---|---|---|
| `co-steer.agentCommand` | `""` | Executable to run on iterate. The artifact path is the final argument. Empty → built-in mock. |
| `co-steer.agentArgs` | `[]` | Extra args passed before the artifact path. |
| `co-steer.promptPrefix` | `Execute the following approved plan:` | Prepended to an approved Markdown artifact on "Run as prompt". |

The agent is launched without a shell (`execFile`/`spawn`), so paths and arguments are
never interpolated into a command line.

## Development

```bash
npm install
npm run package      # type-check + production bundle
npm test             # runs the @vscode/test-electron integration suite
```

Package an installable `.vsix`:

```bash
npm run vsix         # produces co-steer.vsix
```

Install it with **Extensions → ⋯ → Install from VSIX…**, or from the CLI:

```bash
code --install-extension co-steer.vsix
```

> **Note:** the test harness launches a real VS Code instance and cannot run while a
> VS Code-based editor (including forks) holds the `vscode-updating` mutex. Close other
> editors locally, or rely on CI (`.github/workflows/ci.yml`), which runs the suite
> headless under `xvfb`.

See `Testing_Standards.md` and `Telemetry_Standards.md` in the repository for the binding
engineering standards.
