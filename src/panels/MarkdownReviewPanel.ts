import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { parseReviewItems, ReviewItem } from '../utils/sidecar';
import { renderMarkdownToHtml } from '../utils/markdown';
import { addNewComment, addReply, setStatus, sidecarPathFor } from '../utils/sidecarWriter';

/**
 * A rendered-Markdown review surface. VS Code's native comment threads only attach to text
 * editors, so to let users comment on *rendered* markdown we render it ourselves in a webview
 * and provide a select-to-comment UI. All comments still live in the same `.review.md`
 * sidecar, so the agent loop and the native (non-markdown) flow are unchanged.
 */
export class MarkdownReviewPanel {
    private static readonly viewType = 'co-steer.markdownReview';
    private static panels = new Map<string, MarkdownReviewPanel>();

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    private static normalizeKey(filePath: string): string {
        return path.normalize(filePath).toLowerCase();
    }

    public static show(originalFilePath: string): void {
        const key = MarkdownReviewPanel.normalizeKey(originalFilePath);
        const existing = MarkdownReviewPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal();
            existing.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            MarkdownReviewPanel.viewType,
            `Review: ${path.basename(originalFilePath)}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        MarkdownReviewPanel.panels.set(key, new MarkdownReviewPanel(panel, originalFilePath));
    }

    public static getPanel(filePath: string): MarkdownReviewPanel | undefined {
        return MarkdownReviewPanel.panels.get(MarkdownReviewPanel.normalizeKey(filePath));
    }

    public getWebviewPanel(): vscode.WebviewPanel {
        return this.panel;
    }

    /** Refresh any open panel whose artifact or sidecar matches the changed path. */
    public static notifyChanged(changedPath: string): void {
        const isSidecar = changedPath.endsWith('.review.md');
        const original = isSidecar
            ? changedPath.replace(/\.review\.md$/, '')
            : changedPath;
        const key = MarkdownReviewPanel.normalizeKey(original);
        const panel = MarkdownReviewPanel.panels.get(key);
        if (!panel) { return; }
        if (isSidecar) {
            panel.updateCommentsInWebview();
        } else {
            panel.refresh();
        }
    }

    public static disposeAll(): void {
        for (const p of MarkdownReviewPanel.panels.values()) {
            p.panel.dispose();
        }
    }

    private constructor(panel: vscode.WebviewPanel, private readonly originalFilePath: string) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
        this.refresh();
    }

    private updateCommentsInWebview(): void {
        const items = this.readItems();
        this.panel.webview.postMessage({ type: 'updateComments', items });
    }

    private async handleMessage(msg: any): Promise<void> {
        try {
            if (msg.type === 'addComment') {
                const text = await vscode.window.showInputBox({
                    prompt: `Comment on lines ${msg.startLine}-${msg.endLine}`,
                    placeHolder: 'Instructions for the AI…'
                });
                if (!text) {
                    return;
                }
                await addNewComment({
                    originalFilePath: this.originalFilePath,
                    startLine: msg.startLine,
                    endLine: msg.endLine,
                    text,
                    author: 'You'
                });
                logger.counter('md_review.comment', { outcome: 'added' });
                this.updateCommentsInWebview();
            } else if (msg.type === 'reply') {
                const text = await vscode.window.showInputBox({ prompt: 'Reply', placeHolder: 'Your reply…' });
                if (!text) {
                    return;
                }
                await addReply(this.originalFilePath, msg.id, text, 'You');
                logger.counter('md_review.comment', { outcome: 'reply' });
                this.updateCommentsInWebview();
            } else if (msg.type === 'setStatus') {
                await setStatus(this.originalFilePath, msg.id, msg.status);
                logger.counter('md_review.comment', { outcome: `status_${msg.status}` });
                this.updateCommentsInWebview();
            } else if (msg.type === 'copyPrompt') {
                await vscode.commands.executeCommand('co-steer.copyPrompt', vscode.Uri.file(this.originalFilePath));
            } else if (msg.type === 'sendPromptToAntigravity') {
                await vscode.commands.executeCommand('co-steer.sendPromptToAntigravity', vscode.Uri.file(this.originalFilePath));
            } else if (msg.type === 'sendPromptToClaude') {
                await vscode.commands.executeCommand('co-steer.sendPromptToClaude', vscode.Uri.file(this.originalFilePath));
            } else if (msg.type === 'telemetry') {
                if (msg.name === 'webview.comment.activate') {
                    logger.counter('md_review.comment_activate', { from: msg.data.from });
                } else if (msg.name === 'webview.comment.dismiss') {
                    logger.counter('md_review.comment_dismiss', { from: msg.data.from });
                }
            }
        } catch (err: any) {
            logger.error('MarkdownReviewPanel: message handling failed', { error: err.message, type: msg?.type });
            vscode.window.showErrorMessage(`Co-Steer: ${err.message}`);
        }
    }

    private readItems(): ReviewItem[] {
        const sidecarPath = sidecarPathFor(this.originalFilePath);
        if (!fs.existsSync(sidecarPath)) {
            return [];
        }
        try {
            return parseReviewItems(fs.readFileSync(sidecarPath, 'utf8'));
        } catch (err: any) {
            logger.error('MarkdownReviewPanel: failed to read sidecar', { error: err.message, sidecarPath });
            return [];
        }
    }

    public refresh(): void {
        let source = '';
        try {
            if (fs.existsSync(this.originalFilePath)) {
                source = fs.readFileSync(this.originalFilePath, 'utf8');
            }
        } catch (err: any) {
            logger.error('MarkdownReviewPanel: failed to read source', { error: err.message, file: this.originalFilePath });
        }
        const html = renderMarkdownToHtml(source);
        const items = this.readItems();
        this.panel.webview.html = this.getHtml(html, items);
        logger.counter('md_review.render', { items: items.length });
    }

    private getHtml(renderedBody: string, items: ReviewItem[]): string {
        const nonce = getNonce();
        // Embed items as JSON (escape '<' so a payload can't close the script tag early).
        const itemsJson = JSON.stringify(items).replace(/</g, '\\u003c');
        const csp = [
            "default-src 'none'",
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
${STYLE}
</style>
</head>
<body>
<div id="cs-layout">
  <article id="cs-content">${renderedBody}</article>
  <div id="cs-splitter"></div>
  <aside id="cs-comments">
    <div class="cs-head">
      <h3>Comments</h3>
      <button id="cs-copy" title="Copy agent prompt to clipboard">📋 Copy</button>
    </div>
    <div class="cs-agent-actions">
      <button id="cs-send-antigravity" class="cs-agent-btn" title="Send prompt automatically to Antigravity Agent">🚀 Antigravity</button>
      <button id="cs-send-claude" class="cs-agent-btn" title="Send prompt automatically to Claude Code">🤖 Claude</button>
    </div>
    <div id="cs-list"></div>
  </aside>
</div>
<button id="cs-add" hidden>💬 Comment</button>
<script type="application/json" id="cs-items">${itemsJson}</script>
<script nonce="${nonce}">
${SCRIPT}
</script>
</body>
</html>`;
    }

    private dispose(): void {
        MarkdownReviewPanel.panels.delete(MarkdownReviewPanel.normalizeKey(this.originalFilePath));
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); background: var(--vscode-editor-background); }
#cs-layout { display: flex; align-items: stretch; position: relative; }
#cs-content { flex: 1; max-width: 820px; padding: 24px 32px; line-height: 1.6; overflow-wrap: anywhere; }
#cs-content h1, #cs-content h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3em; }
#cs-content pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow: auto; }
#cs-content code { font-family: var(--vscode-editor-font-family); }
#cs-content blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 0; padding-left: 1em; color: var(--vscode-descriptionForeground); }
#cs-content table { border-collapse: collapse; } #cs-content td, #cs-content th { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
.cs-hl { border-radius: 3px; }
.cs-hl-pending { cursor: pointer; background: rgba(255, 197, 61, 0.22); box-shadow: inset 2px 0 0 var(--vscode-editorWarning-foreground); }
.cs-hl-accepted { background: transparent !important; box-shadow: none !important; cursor: default !important; }
.cs-hl-accepted.active { background: rgba(115, 201, 145, 0.16) !important; box-shadow: inset 2px 0 0 var(--vscode-charts-green, #73c991) !important; }
.cs-hl-rejected { background: transparent !important; box-shadow: none !important; cursor: default !important; }
.cs-hl-rejected.active { background: rgba(241, 76, 76, 0.16) !important; box-shadow: inset 2px 0 0 var(--vscode-charts-red, #f14c4c) !important; }
.cs-hl-resolved { background: transparent !important; box-shadow: none !important; cursor: default !important; }
.cs-hl-resolved.active { background: rgba(115, 201, 145, 0.16) !important; box-shadow: inset 2px 0 0 var(--vscode-charts-green, #73c991) !important; }
.cs-card.active { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.cs-flash { animation: csflash 1s ease; }
@keyframes csflash { from { background: var(--vscode-editor-selectionBackground); } to {} }
#cs-comments { width: 320px; min-width: 200px; padding: 16px; box-sizing: border-box; position: relative; align-self: stretch; }
#cs-splitter { width: 4px; cursor: col-resize; background: var(--vscode-panel-border); z-index: 10; user-select: none; flex-shrink: 0; transition: background 0.1s ease; }
#cs-splitter:hover, #cs-splitter.active { background: var(--vscode-focusBorder); }
.cs-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#cs-comments h3 { margin-top: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
#cs-copy { font-size: 11px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 8px; border-radius: 4px; white-space: nowrap; transition: background 0.15s ease; }
#cs-copy:hover { background: var(--vscode-button-secondaryHoverBackground); }
.cs-agent-actions { display: flex; gap: 8px; margin: 10px 0 16px 0; }
.cs-agent-btn { flex: 1; font-size: 11px; font-weight: 500; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 4px; white-space: nowrap; display: flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.15s ease, transform 0.1s ease; }
.cs-agent-btn:hover { background: var(--vscode-button-hoverBackground); }
.cs-agent-btn:active { transform: scale(0.97); }
#cs-list { position: relative; width: 100%; }
.cs-card { position: absolute; left: 0; right: 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; box-sizing: border-box; }
.cs-card.resolved, .cs-card.accepted, .cs-card.rejected { opacity: .7; }
.cs-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.cs-badge.pending { background: var(--vscode-editorWarning-foreground); color: #000; }
.cs-badge.accepted { background: var(--vscode-charts-green, #73c991); color: #000; }
.cs-badge.rejected { background: var(--vscode-charts-red, #f14c4c); color: #fff; }
.cs-badge.resolved { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
.cs-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.cs-author { font-weight: 600; font-size: 12px; }
.cs-comment { font-size: 13px; margin: 4px 0; white-space: pre-wrap; }
.cs-actions { display: flex; gap: 8px; margin-top: 8px; }
.cs-actions button { font-size: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 4px; }
.cs-empty { color: var(--vscode-descriptionForeground); font-size: 13px; }
#cs-add { position: fixed; z-index: 10; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.cs-thread-toggle-container { margin-top: 8px; }
.cs-thread-toggle { font-size: 11px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 4px; }
.cs-thread-toggle:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

export const SCRIPT = `
const vscode = acquireVsCodeApi();
let items = JSON.parse(document.getElementById('cs-items').textContent || '[]');
const content = document.getElementById('cs-content');
const addBtn = document.getElementById('cs-add');
const list = document.getElementById('cs-list');
document.getElementById('cs-copy').addEventListener('click', () => vscode.postMessage({ type: 'copyPrompt' }));
document.getElementById('cs-send-antigravity').addEventListener('click', () => vscode.postMessage({ type: 'sendPromptToAntigravity' }));
document.getElementById('cs-send-claude').addEventListener('click', () => vscode.postMessage({ type: 'sendPromptToClaude' }));

let activeCommentId = null;
const expandedCardIds = new Set();
const expandedCommentIds = new Set();

function setActiveComment(id) {
  activeCommentId = id;
  document.querySelectorAll('.cs-card').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.cs-hl').forEach(el => el.classList.remove('active'));
  if (id) {
    const card = document.getElementById('card-' + id);
    if (card) card.classList.add('active');
    const item = items.find(i => i.id === id);
    if (item) {
        const start0 = (item.startLine || 1) - 1;
        const endExcl = (item.endLine || item.startLine || 1);
        elementsForRange(start0, endExcl).forEach(el => el.classList.add('active'));
    }
  }
}

function positionCards() {
  if (!items.length) {
    list.style.height = '';
    return;
  }
  const listRect = list.getBoundingClientRect();
  let lastBottom = 0;
  const spacing = 12; // spacing between cards in px
  
  items.forEach(item => {
    const card = document.getElementById('card-' + item.id);
    if (!card) return;
    
    const start0 = (item.startLine || 1) - 1;
    const endExcl = (item.endLine || item.startLine || 1);
    const targetEls = elementsForRange(start0, endExcl);
    
    let targetTop = 0;
    if (targetEls.length > 0) {
      const elRect = targetEls[0].getBoundingClientRect();
      targetTop = elRect.top - listRect.top;
    } else {
      targetTop = lastBottom;
    }
    
    if (targetTop < lastBottom) {
      targetTop = lastBottom;
    }
    
    card.style.top = targetTop + 'px';
    const cardHeight = card.offsetHeight;
    lastBottom = targetTop + cardHeight + spacing;
  });
  
  list.style.height = lastBottom + 'px';
}

window.addEventListener('resize', positionCards);

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'updateComments') {
    items = message.items;
    renderComments();
  } else if (message.type === 'runTest') {
    (async () => {
      try {
        // 1. Layout & Styling properties test
        const commentsCol = document.getElementById('cs-comments');
        const commentsStyle = window.getComputedStyle(commentsCol);
        if (commentsStyle.position === 'sticky') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'cs-comments should not have position: sticky' });
          return;
        }
        if (commentsStyle.overflow === 'auto' || commentsStyle.overflow === 'scroll') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'cs-comments should not have overflow scroll/auto' });
          return;
        }
        
        // 2. Card Alignment Test
        const card = document.querySelector('.cs-card');
        const block = document.querySelector('.cs-hl');
        if (!card || !block) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card or highlight element not found' });
          return;
        }
        const listRect = list.getBoundingClientRect();
        const blockRect = block.getBoundingClientRect();
        const expectedTop = blockRect.top - listRect.top;
        const actualTop = parseFloat(card.style.top);
        if (isNaN(actualTop)) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card style.top is not set or is NaN' });
          return;
        }
        if (Math.abs(actualTop - expectedTop) > 2) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card top (' + actualTop + ') is not aligned next to text block (' + expectedTop + ')' });
          return;
        }

        // 3. Collision Resolution, Sorting, and Collapsing Test
        const originalItems = [...items];
        const originalExpandedCards = new Set(expandedCardIds);
        const originalExpandedComments = new Set(expandedCommentIds);
        
        items = [
          {
            id: 'test-collapse-a',
            startLine: 1,
            endLine: 1,
            status: 'pending',
            comments: [{ author: 'You', text: 'Short comment' }]
          },
          {
            id: 'test-collapse-b',
            startLine: 2,
            endLine: 2,
            status: 'resolved',
            comments: [
              { author: 'You', text: 'First message' },
              { author: 'Agent', text: 'Reply 1' },
              { author: 'You', text: 'Reply 2' }
            ]
          },
          {
            id: 'test-collapse-c',
            startLine: 3,
            endLine: 3,
            status: 'resolved',
            comments: [{ author: 'You', text: 'A'.repeat(200) }]
          }
        ];
        
        expandedCardIds.clear();
        expandedCommentIds.clear();
        renderComments();
        
        const cards = Array.from(document.querySelectorAll('.cs-card'));
        if (cards.length !== 3) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Expected 3 cards rendered for collapse test, found ' + cards.length });
          return;
        }
        
        const cardA = document.getElementById('card-test-collapse-a');
        if (!cardA.querySelector('[data-act="reply"]')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card A should be expanded' });
          return;
        }
        if (cardA.querySelector('.cs-thread-toggle')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card A should not have thread toggle' });
          return;
        }
        
        const cardB = document.getElementById('card-test-collapse-b');
        if (cardB.querySelector('[data-act="reply"]')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B (resolved) should be collapsed and hide actions' });
          return;
        }
        const toggleB = cardB.querySelector('.cs-thread-toggle');
        if (!toggleB || toggleB.textContent !== 'Expand Thread') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B should have "Expand Thread" button' });
          return;
        }
        
        const cardC = document.getElementById('card-test-collapse-c');
        const textToggleC = cardC.querySelector('.cs-text-toggle');
        if (!textToggleC || textToggleC.textContent !== 'Show more') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card C should have "Show more" text toggle' });
          return;
        }
        if (!cardC.querySelector('.cs-comment').textContent.includes('...')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card C text should be truncated' });
          return;
        }

        // 4. Expand resolved Card B and verify height recalculation
        const beforeExpandTopC = parseFloat(cardC.style.top);
        const heightBeforeExpandB = cardB.offsetHeight;
        
        toggleB.click();
        
        if (!expandedCardIds.has('test-collapse-b')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'test-collapse-b ID should be in expandedCardIds' });
          return;
        }
        
        const cardBExpanded = document.getElementById('card-test-collapse-b');
        const heightAfterExpandB = cardBExpanded.offsetHeight;
        if (heightAfterExpandB <= heightBeforeExpandB) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B height should increase when expanded. Before: ' + heightBeforeExpandB + ', After: ' + heightAfterExpandB });
          return;
        }
        
        const cardCExpanded = document.getElementById('card-test-collapse-c');
        const afterExpandTopC = parseFloat(cardCExpanded.style.top);
        const expectedShift = heightAfterExpandB - heightBeforeExpandB;
        if (Math.abs(afterExpandTopC - beforeExpandTopC - expectedShift) > 2) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card C should be pushed down by the exact height difference. Expected shift: ' + expectedShift + ', Actual: ' + (afterExpandTopC - beforeExpandTopC) });
          return;
        }
        
        if (!cardBExpanded.querySelector('[data-act="reply"]')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B should show actions when expanded' });
          return;
        }
        if (cardBExpanded.querySelector('.cs-thread-toggle').textContent !== 'Collapse Thread') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B should show "Collapse Thread" when expanded' });
          return;
        }

        cardBExpanded.querySelector('.cs-thread-toggle').click();
        const cardCCollapsed = document.getElementById('card-test-collapse-c');
        const finalTopC = parseFloat(cardCCollapsed.style.top);
        if (Math.abs(finalTopC - beforeExpandTopC) > 2) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card C should return to its original top position when B collapses' });
          return;
        }

        // 5. Long Comment Chain (pending, >2 comments) Collapse Test
        items[1].status = 'pending';
        expandedCardIds.clear();
        renderComments();
        
        const cardBChain = document.getElementById('card-test-collapse-b');
        if (cardBChain.querySelector('[data-act="reply"]')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B (long chain, pending) should be collapsed by default' });
          return;
        }
        const toggleBChain = cardBChain.querySelector('.cs-thread-toggle');
        if (!toggleBChain || toggleBChain.textContent !== 'Show 2 more replies') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B should show "Show 2 more replies" button' });
          return;
        }
        
        toggleBChain.click();
        const cardBChainExpanded = document.getElementById('card-test-collapse-b');
        if (!cardBChainExpanded.querySelector('[data-act="reply"]')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B should show actions when expanded chain' });
          return;
        }
        if (cardBChainExpanded.querySelector('.cs-thread-toggle').textContent !== 'Collapse Thread') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card B should show "Collapse Thread" when expanded chain' });
          return;
        }

        // 6. Long text toggle test
        const cardCText = document.getElementById('card-test-collapse-c');
        const textToggleCToClick = cardCText.querySelector('.cs-text-toggle');
        textToggleCToClick.click();
        
        const cardCExpandedText = document.getElementById('card-test-collapse-c');
        if (!expandedCommentIds.has('test-collapse-c-0')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'test-collapse-c-0 should be in expandedCommentIds' });
          return;
        }
        if (cardCExpandedText.querySelector('.cs-comment').textContent.includes('...')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card C text should not be truncated after click' });
          return;
        }
        const newToggleC = cardCExpandedText.querySelector('.cs-text-toggle');
        if (!newToggleC || newToggleC.textContent !== 'Show less') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Card C should show "Show less" toggle' });
          return;
        }
        
        newToggleC.click();
        const cardCCollapsedText = document.getElementById('card-test-collapse-c');
        if (expandedCommentIds.has('test-collapse-c-0')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'test-collapse-c-0 should be removed from expandedCommentIds' });
          return;
        }

        // Restore
        items = originalItems;
        expandedCardIds.clear();
        originalExpandedCards.forEach(id => expandedCardIds.add(id));
        expandedCommentIds.clear();
        originalExpandedComments.forEach(id => expandedCommentIds.add(id));
        renderComments();

        // 7. Accept/Reject/Reopen flow test
        const testCard = document.querySelector('.cs-card');
        const testBlock = document.querySelector('.cs-hl');
        if (!testCard || !testBlock) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Restore card or highlight element not found' });
          return;
        }
        if (!testBlock.classList.contains('cs-hl-pending')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Initial highlight should be pending' });
          return;
        }

        // Click card to make it active, check it becomes active
        testCard.click();
        if (!testCard.classList.contains('active') || !testBlock.classList.contains('active')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Should become active on card click' });
          return;
        }

        // Find Accept button (which sets status="accepted")
        const acceptBtn = testCard.querySelector('[data-act="status"][data-status="accepted"]');
        if (!acceptBtn) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Accept button not found on pending card' });
          return;
        }

        const waitForUpdate = () => {
          return new Promise(resolve => {
            const handler = (e) => {
              if (e.data.type === 'updateComments') {
                window.removeEventListener('message', handler);
                setTimeout(resolve, 50);
              }
            };
            window.addEventListener('message', handler);
          });
        };

        // Click Accept, wait for update
        const update1 = waitForUpdate();
        acceptBtn.click();
        await update1;

        // Verify status is accepted
        const cardAfterAccept = document.querySelector('.cs-card');
        const blockAfterAccept = document.querySelector('.cs-hl');
        if (cardAfterAccept.classList.contains('active') || blockAfterAccept.classList.contains('active')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Active highlight should disappear on accept' });
          return;
        }
        if (!blockAfterAccept.classList.contains('cs-hl-accepted')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Highlight should be cs-hl-accepted after Accept' });
          return;
        }
        const badgeAfterAccept = cardAfterAccept.querySelector('.cs-badge');
        if (!badgeAfterAccept || badgeAfterAccept.textContent !== 'accepted') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Badge should be accepted after Accept' });
          return;
        }

        // Verify Reopen button is visible when collapsed
        const reopenBtnCollapsed = cardAfterAccept.querySelector('[data-act="status"][data-status="pending"]');
        if (!reopenBtnCollapsed) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Reopen button should be visible when collapsed on accepted card' });
          return;
        }

        // Expand thread to access Reopen button
        const toggleAfterAccept = cardAfterAccept.querySelector('.cs-thread-toggle');
        if (!toggleAfterAccept) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Thread toggle not found on accepted card' });
          return;
        }
        toggleAfterAccept.click();

        // Find Reopen button (which sets status="pending") - re-query since card was recreated
        const cardAfterAcceptExpand = document.querySelector('.cs-card');
        const reopenBtn = cardAfterAcceptExpand.querySelector('[data-act="status"][data-status="pending"]');
        if (!reopenBtn) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Reopen button not found on accepted card' });
          return;
        }

        // Click Reopen, wait for update
        const update2 = waitForUpdate();
        reopenBtn.click();
        await update2;

        // Verify status returned to pending
        const cardAfterReopen = document.querySelector('.cs-card');
        const blockAfterReopen = document.querySelector('.cs-hl');
        if (!blockAfterReopen.classList.contains('cs-hl-pending')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Highlight should return to cs-hl-pending after Reopen' });
          return;
        }

        // Click Reject button (which sets status="rejected")
        const rejectBtn = cardAfterReopen.querySelector('[data-act="status"][data-status="rejected"]');
        if (!rejectBtn) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Reject button not found on pending card after reopen' });
          return;
        }

        // Click Reject, wait for update
        const update3 = waitForUpdate();
        rejectBtn.click();
        await update3;

        // Verify status is rejected
        const cardAfterReject = document.querySelector('.cs-card');
        const blockAfterReject = document.querySelector('.cs-hl');
        if (cardAfterReject.classList.contains('active') || blockAfterReject.classList.contains('active')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Active highlight should disappear on reject' });
          return;
        }
        if (!blockAfterReject.classList.contains('cs-hl-rejected')) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Highlight should be cs-hl-rejected after Reject' });
          return;
        }
        const badgeAfterReject = cardAfterReject.querySelector('.cs-badge');
        if (!badgeAfterReject || badgeAfterReject.textContent !== 'rejected') {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Badge should be rejected after Reject' });
          return;
        }

        // Verify Reopen button is visible when collapsed on rejected card
        const reopenBtnRejectedCollapsed = cardAfterReject.querySelector('[data-act="status"][data-status="pending"]');
        if (!reopenBtnRejectedCollapsed) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Reopen button should be visible when collapsed on rejected card' });
          return;
        }

        // Expand thread to access Reopen button on rejected card
        const toggleAfterReject = cardAfterReject.querySelector('.cs-thread-toggle');
        if (!toggleAfterReject) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'Thread toggle not found on rejected card' });
          return;
        }
        toggleAfterReject.click();

        // Reopen it so that subsequent runs or tests are clean - re-query since card was recreated
        const cardAfterRejectExpand = document.querySelector('.cs-card');
        const reopenBtn2 = cardAfterRejectExpand.querySelector('[data-act="status"][data-status="pending"]');
        if (reopenBtn2) {
          const update4 = waitForUpdate();
          reopenBtn2.click();
          await update4;
        }

        // 8. Splitter Test
        const splitterEl = document.getElementById('cs-splitter');
        if (!splitterEl) {
          vscode.postMessage({ type: 'testResult', success: false, error: 'cs-splitter element not found' });
          return;
        }

        vscode.postMessage({ type: 'testResult', success: true });
      } catch (err) {
        vscode.postMessage({ type: 'testResult', success: false, error: 'Async test error: ' + err.message });
      }
    })();
  }
});

window.addEventListener('click', e => {
  let target = e.target;
  let isCard = false;
  let clickedHighlight = false;
  
  while (target) {
    if (target.classList && target.classList.contains('cs-card')) {
      isCard = true;
      break;
    }
    if (target.classList && target.classList.contains('cs-hl') && target.dataset.commentId) {
      const commentId = target.dataset.commentId;
      if (activeCommentId === commentId) {
          vscode.postMessage({ type: 'telemetry', name: 'webview.comment.dismiss', data: { from: 'highlight' } });
          setActiveComment(null);
      } else {
          vscode.postMessage({ type: 'telemetry', name: 'webview.comment.activate', data: { from: 'highlight' } });
          setActiveComment(commentId);
          const card = document.getElementById('card-' + commentId);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
      }
      clickedHighlight = true;
      break;
    }
    target = target.parentElement;
  }
  
  if (!isCard && !clickedHighlight) {
    if (activeCommentId !== null) {
        vscode.postMessage({ type: 'telemetry', name: 'webview.comment.dismiss', data: { from: 'background' } });
    }
    setActiveComment(null);
  }
});

function blocks() { return Array.from(content.querySelectorAll('[data-line]')); }

function elementsForRange(start0, endExcl) {
  return blocks().filter(el => {
    const s = +el.dataset.line, e = +el.dataset.lineEnd;
    return s < endExcl && e > start0; // overlap
  });
}

function renderCommentText(commentId, text, forceExpand) {
  if (text.length <= 150) {
    return esc(text);
  }
  const isExpanded = forceExpand || expandedCommentIds.has(commentId);
  if (isExpanded) {
    if (forceExpand) {
      return esc(text);
    }
    return esc(text) + ' <span class="cs-text-toggle" data-cid="' + commentId + '" style="color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; margin-left: 4px;">Show less</span>';
  } else {
    const truncated = text.slice(0, 120) + '...';
    return esc(truncated) + ' <span class="cs-text-toggle" data-cid="' + commentId + '" style="color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; margin-left: 4px;">Show more</span>';
  }
}

// Highlight commented ranges and build the comments sidebar.
function renderComments() {
  blocks().forEach(el => {
    el.classList.remove('cs-hl', 'cs-hl-pending', 'cs-hl-accepted', 'cs-hl-rejected', 'cs-hl-resolved', 'active');
    delete el.dataset.commentId;
  });
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<div class="cs-empty">No comments yet. Select text to add one.</div>'; list.style.height = ''; return; }
  
  items.sort((a, b) => (a.startLine || 1) - (b.startLine || 1));

  items.forEach(item => {
    const start0 = (item.startLine || 1) - 1;
    const endExcl = (item.endLine || item.startLine || 1);
    elementsForRange(start0, endExcl).forEach(el => {
      el.classList.add('cs-hl', 'cs-hl-' + item.status);
      el.dataset.commentId = item.id;
    });

    const card = document.createElement('div');
    card.className = 'cs-card ' + item.status;
    card.id = 'card-' + item.id;

    const isDone = item.status !== 'pending';
    const hasManyReplies = item.comments.length > 2;
    const isThreadCollapsed = (isDone || hasManyReplies) && !expandedCardIds.has(item.id);

    let commentsHtml = '';
    let toggleHtml = '';
    let actionsHtml = '';

    if (isThreadCollapsed) {
      const firstComment = item.comments[0];
      const commentId = item.id + '-0';
      commentsHtml = '<div class="cs-comment"><span class="cs-author">' + esc(firstComment.author) + ':</span> ' + renderCommentText(commentId, firstComment.text, false) + '</div>';
      
      const label = isDone ? 'Expand Thread' : 'Show ' + (item.comments.length - 1) + ' more replies';
      toggleHtml = '<div class="cs-thread-toggle-container"><button class="cs-thread-toggle" data-id="' + item.id + '">' + label + '</button></div>';
      if (isDone) {
        actionsHtml = '<div class="cs-actions"><button data-act="status" data-status="pending">Reopen</button></div>';
      }
    } else {
      commentsHtml = item.comments.map((c, idx) => {
        const commentId = item.id + '-' + idx;
        return '<div class="cs-comment"><span class="cs-author">' + esc(c.author) + ':</span> ' + renderCommentText(commentId, c.text, true) + '</div>';
      }).join('');

      if (isDone || hasManyReplies) {
        toggleHtml = '<div class="cs-thread-toggle-container"><button class="cs-thread-toggle" data-id="' + item.id + '">Collapse Thread</button></div>';
      }

      if (item.status === 'pending') {
        actionsHtml = '<div class="cs-actions"><button data-act="reply">Reply</button>' +
                      '<button data-act="status" data-status="accepted">Accept</button>' +
                      '<button data-act="status" data-status="rejected">Reject</button></div>';
      } else {
        actionsHtml = '<div class="cs-actions"><button data-act="reply">Reply</button>' +
                      '<button data-act="status" data-status="pending">Reopen</button></div>';
      }
    }

    card.innerHTML =
      '<div class="cs-meta"><span class="cs-lines">Lines ' + (item.startLine||'?') + '-' + (item.endLine||'?') + '</span>' +
      '<span class="cs-badge ' + item.status + '">' + item.status + '</span></div>' +
      commentsHtml +
      toggleHtml +
      actionsHtml;

    card.querySelectorAll('.cs-text-toggle').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const cid = el.dataset.cid;
        if (expandedCommentIds.has(cid)) {
          expandedCommentIds.delete(cid);
        } else {
          expandedCommentIds.add(cid);
        }
        renderComments();
      });
    });

    card.querySelectorAll('.cs-thread-toggle').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const id = el.dataset.id;
        if (expandedCardIds.has(id)) {
          expandedCardIds.delete(id);
        } else {
          expandedCardIds.add(id);
        }
        renderComments();
      });
    });

    const replyBtn = card.querySelector('[data-act="reply"]');
    if (replyBtn) {
      replyBtn.addEventListener('click', () => vscode.postMessage({ type: 'reply', id: item.id }));
    }

    card.querySelectorAll('[data-act="status"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetStatus = btn.dataset.status;
        if (targetStatus !== 'pending' && activeCommentId === item.id) {
          setActiveComment(null);
        }
        vscode.postMessage({ type: 'setStatus', id: item.id, status: targetStatus });
      });
    });

    card.addEventListener('click', e => { 
        if (e.target.tagName !== 'BUTTON' && !e.target.classList.contains('cs-text-toggle')) {
            if (activeCommentId === item.id) {
                vscode.postMessage({ type: 'telemetry', name: 'webview.comment.dismiss', data: { from: 'card' } });
                setActiveComment(null);
            } else {
                vscode.postMessage({ type: 'telemetry', name: 'webview.comment.activate', data: { from: 'card' } });
                setActiveComment(item.id);
                scrollToRange(start0, endExcl); 
            }
        }
    });

    list.appendChild(card);
  });

  positionCards();

  if (activeCommentId) {
      const activeItem = items.find(i => i.id === activeCommentId);
      if (activeItem && activeItem.status !== 'pending') {
          setActiveComment(null);
      } else {
          setActiveComment(activeCommentId);
      }
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

function focusCard(id) {
  const card = document.getElementById('card-' + id);
  if (card) { card.scrollIntoView({ block: 'nearest' }); card.classList.add('cs-flash'); setTimeout(() => card.classList.remove('cs-flash'), 1000); }
}

function scrollToRange(start0, endExcl) {
  const els = elementsForRange(start0, endExcl);
  if (els[0]) { els[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); els[0].classList.add('cs-flash'); setTimeout(() => els[0].classList.remove('cs-flash'), 1000); }
}

function lineInfo(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el && !(el.dataset && el.dataset.line)) el = el.parentElement;
  return el ? { start: +el.dataset.line, end: +el.dataset.lineEnd } : null;
}

document.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { addBtn.hidden = true; return; }
  const a = lineInfo(sel.anchorNode), b = lineInfo(sel.focusNode);
  if (!a || !b) { addBtn.hidden = true; return; }
  const startLine = Math.min(a.start, b.start) + 1;
  const endLine = Math.max(a.end, b.end); // exclusive 0-based end == inclusive 1-based last line
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  addBtn.style.top = (rect.bottom + 6) + 'px';
  addBtn.style.left = Math.max(8, rect.left) + 'px';
  addBtn.hidden = false;
  addBtn.onclick = () => { addBtn.hidden = true; vscode.postMessage({ type: 'addComment', startLine, endLine }); };
});

const prev = vscode.getState();
if (prev) {
  if (typeof prev.scrollY === 'number') {
    setTimeout(() => window.scrollTo(0, prev.scrollY), 0);
  }
  if (typeof prev.commentsWidth === 'number') {
    const commentsAside = document.getElementById('cs-comments');
    commentsAside.style.width = prev.commentsWidth + 'px';
    commentsAside.style.minWidth = prev.commentsWidth + 'px';
  }
}

window.addEventListener('scroll', () => {
  const state = vscode.getState() || {};
  state.scrollY = window.scrollY;
  vscode.setState(state);
});

// Splitter Dragging Logic
const splitter = document.getElementById('cs-splitter');
const commentsAside = document.getElementById('cs-comments');
let isDragging = false;
let startX = 0;
let startWidth = 0;

splitter.addEventListener('mousedown', e => {
  isDragging = true;
  startX = e.clientX;
  startWidth = commentsAside.offsetWidth;
  splitter.classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const deltaX = e.clientX - startX;
  let newWidth = startWidth - deltaX;
  if (newWidth < 200) newWidth = 200;
  if (newWidth > 800) newWidth = 800;
  commentsAside.style.width = newWidth + 'px';
  commentsAside.style.minWidth = newWidth + 'px';
  positionCards();
});

window.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    splitter.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const state = vscode.getState() || {};
    state.commentsWidth = commentsAside.offsetWidth;
    vscode.setState(state);
  }
});

renderComments();
try { vscode.postMessage({ type: 'ready' }); } catch(e){}
`;
