# Implementation Plan: Webview Scroll Preservation & Resolved Comment Hiding

We will implement two major enhancements to resolve the observations:
1. **Dynamic Webview Updates (Scroll Preservation)**: Avoid full page reloads in the Markdown review panel by using `postMessage` for comment updates (additions, replies, status changes), preserving the scroll position.
2. **Inline Resolved Comment Hiding (Option B)**: Keep all comments in the existing `.review.md` sidecar file to avoid file bloat. Move resolved comments to an HTML comment block (`<!-- COSTEER_RESOLVED_START ... -->`) at the bottom of the file and instruct agents to ignore them.

---

## Proposed Changes

### 1. Webview Scroll Preservation
#### [MODIFY] [MarkdownReviewPanel.ts](file:///C:/Users/Frank/Documents/antigravity/co-steer/src/panels/MarkdownReviewPanel.ts)
- **Root cause**: `this.panel.webview.html = ...` replaces the entire page on every comment action, causing a full context reset. `vscode.getState()` already saves the scroll position, but `window.scrollTo` races DOM layout on the fresh page and usually loses. The fix is to avoid the full HTML replacement for comment-only updates.
- For add/reply/status-change actions, replace the `this.refresh()` call in `handleMessage()` with a new `this.updateCommentsInWebview()` helper that sends the updated items list via `postMessage`. This leaves the article HTML (and scroll position) untouched.
- Switch comment card click handlers to **event delegation** on `#cs-content`. This is **required** by the postMessage approach: `updateCommentsInWebview()` will call `renderComments()` on every update, and without delegation each call stacks duplicate listeners on the same elements.
- Keep `this.refresh()` (full HTML replacement) for the initial load and for cases where the article content itself changes; the `setTimeout` scroll-restoration fallback is only needed on that path.

### 2. Inline Resolved Comment Hiding
#### [MODIFY] [sidecar.ts](file:///C:/Users/Frank/Documents/antigravity/co-steer/src/utils/sidecar.ts)
- Update `buildSidecarContent` to separate `pending` and `resolved` items.
- Write resolved items at the bottom of the file inside an HTML comment block:
  ```markdown
  <!-- COSTEER_RESOLVED_START

  <review_item status="resolved" ...>
  ...
  </review_item>

  COSTEER_RESOLVED_END -->
  ```
- Because `parseReviewItems` uses a simple regex (`/<review_item...>/g`), it will continue to parse these resolved comments perfectly for the extension UI.
- **Rename the file header** from `# Pending Review Comments for \`${fileName}\`` to `# Review Comments for \`${fileName}\`` — once resolved items are also stored in the file the old heading would mislead an agent into thinking it needs to address the resolved block.

#### [MODIFY] [reviewPrompt.ts](file:///C:/Users/Frank/Documents/antigravity/co-steer/src/agent/reviewPrompt.ts)
- Update the agent prompt with explicit, unambiguous wording: **"Do NOT process review items inside `<!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END -->` — they are already resolved and must be left unchanged."** Softer phrasing like "ignore resolved comments" is easy for a model to overlook.
- Known limitation: if an agent is given the sidecar file directly without the Co-Steer prompt (e.g. via workspace rules alone), it has no instruction to skip the resolved block and may act on those items. Document this in the plan as an accepted risk.

#### [MODIFY] [workspaceRules.ts](file:///C:/Users/Frank/Documents/antigravity/co-steer/src/agent/workspaceRules.ts)
- Update `COSTEER_INSTRUCTIONS` to explicitly instruct agents to ignore review items inside the `<!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END -->` block.
- Add a `COSTEER_RULES_VERSION` constant (e.g. `'2'`). On extension activation, compare the version stored in workspace state against the current constant; if they differ, re-run `generateWorkspaceRules` to reinject the updated instructions into all existing rule files (`.cursorrules`, `CLAUDE.md`, etc.) and then update the stored version. This ensures workspaces that already have the old rules automatically receive the "ignore resolved" instruction without any manual action.

---

## Verification Plan

### Automated Tests
We will add/update unit and integration tests under `src/test/suite/`:
- Test that `buildSidecarContent` writes resolved comments inside the HTML comment block.
- Test that `parseReviewItems` successfully extracts resolved comments from the HTML comment block.
- Test scroll preservation via webview postMessage events.

### Manual Verification
- Start the extension, create comments, resolve them, and check that:
  - Scroll position remains unchanged.
  - Resolved comments move to the commented-out block in the sidecar file.
  - Opening the virtual view displays both pending and resolved comments correctly.
