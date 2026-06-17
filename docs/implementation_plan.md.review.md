# Pending Review Comments for `implementation_plan.md`

<review_item id="r-ee09cf2465" status="resolved">
<location>
File: `implementation_plan.md`
Lines: 5-6
</location>

<target_code>
```md
2. **Inline Resolved Comment Hiding (Option B)**: Keep all comments in the existing `.review.md` sidecar file to avoid file bloat. Move resolved comments to an HTML comment block (`<!-- COSTEER_RESOLVED_START ... -->`) at the bottom of the file and instruct agents to ignore them.

```
</target_code>

<comment author="You">
I like the idea of keeping everything in one file but i want to make sure agents will ignore resolved comments
</comment>
</review_item>

<review_item id="r-scroll-state-already-exists" status="resolved">
<location>
File: `implementation_plan.md`
Lines: 13-17
</location>

<target_code>
```md
### 1. Webview Scroll Preservation
#### [MODIFY] [MarkdownReviewPanel.ts](...)
- Refactor comments rendering and highlights to use **event delegation** on `#cs-content` to prevent listener accumulation.
- Listen for `message` events in the webview to handle dynamic updates of comments and highlights.
- In `handleMessage()`, instead of calling `this.refresh()` (which resets the entire HTML), call a new `this.updateCommentsInWebview()` helper that pushes the updated comments list via `postMessage`.
- Make scroll restoration on full HTML reload robust using `setTimeout` to wait for layout completion.
```
</target_code>

<comment author="You">
Scroll state is already persisted today via `vscode.getState()` / `vscode.setState()` in the webview SCRIPT (MarkdownReviewPanel.ts:299-302). The root problem isn't that state isn't saved — it's that assigning a new string to `this.panel.webview.html` causes a full context reset, and the `window.scrollTo(0, prev.scrollY)` call races against DOM layout. The `postMessage` path fixes this correctly by avoiding the HTML reassignment for comment-only updates.

Also, the event delegation note needs clarification: today `renderComments()` is called only once at startup (SCRIPT:304), so there is no listener accumulation yet. It becomes a real issue only after we wire the `message` event handler to call `renderComments()` again on each update — make this dependency explicit in the plan so the reviewer doesn't miss it.
</comment>

<comment author="You">
I am not sure I understand please explain differantly
</comment>

<comment author="Agent">
Sure — think of it in two separate parts:

**Part 1: why scroll breaks today**
Every time you add a comment or resolve one, `handleMessage()` calls `this.refresh()`, which replaces the entire HTML of the webview panel. It is like navigating to a new page: the browser resets to the top. The code does try to save your scroll position using `vscode.getState()`, but because the whole page reloads at once, the `window.scrollTo` that restores it often fires before the page has finished laying itself out, so it has no effect. The fix is to *not* replace the whole page for comment updates — instead send only the new comment data over `postMessage` and update just the sidebar, leaving the rest of the page (and your scroll position) untouched.

**Part 2: why event delegation matters for the new approach**
Today `renderComments()` (the function that draws comment cards and attaches click handlers) runs exactly once when the page loads. That is fine. Under the new approach, every time a `postMessage` arrives with updated comments, we will call `renderComments()` again. Each call re-creates the cards and attaches *new* click handlers, but the old handlers from the previous call are still attached — they just pile up. Event delegation moves the single click handler to the parent `#cs-content` element so it never needs to be re-added; child elements are matched at click time. The plan should make clear that event delegation is *required* by the postMessage approach, not a separate nice-to-have.
</comment>

<comment author="You">
ok I understand make the changes to the plan
</comment>

<comment author="Agent">
Applied. Rewrote the MarkdownReviewPanel.ts bullets to: explain the root cause (full HTML replacement races scroll restore), make postMessage + updateCommentsInWebview the primary fix, and mark event delegation as required (not optional) because renderComments() will be called on every postMessage update.
</comment>
</review_item>

<review_item id="r-header-mismatch" status="resolved">
<location>
File: `implementation_plan.md`
Lines: 19-31
</location>

<target_code>
```md
#### [MODIFY] [sidecar.ts](...)
- Update `buildSidecarContent` to separate `pending` and `resolved` items.
- Write resolved items at the bottom of the file inside an HTML comment block
```
</target_code>

<comment author="You">
`buildSidecarContent` currently emits the header `# Pending Review Comments for \`${fileName}\`` (sidecar.ts:121). After this change the file will contain both pending *and* resolved items, making that header misleading to agents. Update it to something like `# Review Comments for \`${fileName}\`` at the same time — otherwise an agent reading "Pending Review Comments" may try to process the resolved block thinking those items need work.
</comment>

<comment author="You">
good catch
</comment>

<comment author="Agent">
Applied. Added a bullet to the `sidecar.ts` section of the plan: rename the header from `# Pending Review Comments for \`${fileName}\`` to `# Review Comments for \`${fileName}\``.
</comment>
</review_item>

<review_item id="r-agent-enforcement-strength" status="resolved">
<location>
File: `implementation_plan.md`
Lines: 33-38
</location>

<target_code>
```md
#### [MODIFY] [reviewPrompt.ts](...)
- Update the agent prompt to explicitly instruct agents to ignore resolved comments located in the HTML comment block at the bottom of the sidecar.

#### [MODIFY] [workspaceRules.ts](...)
- Update the workspace rules to explicitly instruct agents to ignore resolved comments in the sidecar.
```
</target_code>

<comment author="You">
LLMs can read text inside HTML `<!-- -->` comments — the wrapper is a convention, not a hard filter. Enforcement is entirely instructional, so the wording in both `reviewPrompt.ts` and `workspaceRules.ts` needs to be unambiguous. I'd suggest something like: **"Do NOT process review items inside `<!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END -->` — they are already resolved and must be left unchanged."** A softer phrasing like "ignore resolved comments" is easy for a model to overlook.

Also worth noting as a known limitation in the plan: if an agent is given the file directly (not via the Co-Steer prompt), it has no instruction to ignore the block, so it may act on resolved items.
</comment>

<comment author="Agent">
Applied. Updated the reviewPrompt.ts bullet to include the exact strong wording and added an explicit known-limitation note about agents that receive the sidecar without the Co-Steer prompt.
</comment>
</review_item>

<review_item id="r-workspace-rules-migration" status="resolved">
<location>
File: `implementation_plan.md`
Lines: 36-38
</location>

<target_code>
```md
#### [MODIFY] [workspaceRules.ts](...)
- Update the workspace rules to explicitly instruct agents to ignore resolved comments in the sidecar.
```
</target_code>

<comment author="You">
`COSTEER_INSTRUCTIONS` in `workspaceRules.ts` is written to user files (`.cursorrules`, `CLAUDE.md`, etc.) only once — `checkAndPromptWorkspaceRules` skips the prompt if `COSTEER_MARKER_START` is already present. Updating the constant won't update already-written files, so existing workspaces won't pick up the "ignore resolved" instruction automatically.

The plan needs to address this: either (a) add a version bump that triggers re-injection on extension update, or (b) document it as a known gap with a manual "Regenerate Rules" action. Without a migration path, the workspace rules fix only helps new workspaces.
</comment>

<comment author="You">
Update and reinject feels right
</comment>

<comment author="Agent">
Applied. Updated the `workspaceRules.ts` section: add a `COSTEER_RULES_VERSION` constant and on activation compare it to the persisted workspace-state value; if different, re-run `generateWorkspaceRules` to reinject updated instructions into all existing rule files, then bump the stored version.
</comment>
</review_item>
