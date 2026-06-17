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
                await setStatus(this.originalFilePath, msg.id, msg.status === 'resolved' ? 'resolved' : 'pending');
                logger.counter('md_review.comment', { outcome: `status_${msg.status}` });
                this.updateCommentsInWebview();
            } else if (msg.type === 'copyPrompt') {
                await vscode.commands.executeCommand('co-steer.copyPrompt', vscode.Uri.file(this.originalFilePath));
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
  <aside id="cs-comments"><div class="cs-head"><h3>Comments</h3><button id="cs-copy" title="Copy an instruction to paste into your AI agent">📋 Copy agent prompt</button></div><div id="cs-list"></div></aside>
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
#cs-layout { display: flex; align-items: flex-start; }
#cs-content { flex: 1; max-width: 820px; padding: 24px 32px; line-height: 1.6; overflow-wrap: anywhere; }
#cs-content h1, #cs-content h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3em; }
#cs-content pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow: auto; }
#cs-content code { font-family: var(--vscode-editor-font-family); }
#cs-content blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 0; padding-left: 1em; color: var(--vscode-descriptionForeground); }
#cs-content table { border-collapse: collapse; } #cs-content td, #cs-content th { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
.cs-hl { cursor: pointer; border-radius: 3px; }
.cs-hl-pending { background: rgba(255, 197, 61, 0.22); box-shadow: inset 2px 0 0 var(--vscode-editorWarning-foreground); }
.cs-hl-resolved { background: rgba(115, 201, 145, 0.16); box-shadow: inset 2px 0 0 var(--vscode-charts-green, #73c991); }
.cs-flash { animation: csflash 1s ease; }
@keyframes csflash { from { background: var(--vscode-editor-selectionBackground); } to {} }
#cs-comments { width: 320px; min-width: 320px; border-left: 1px solid var(--vscode-panel-border); padding: 16px; height: 100vh; overflow: auto; box-sizing: border-box; position: sticky; top: 0; }
.cs-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#cs-comments h3 { margin-top: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
#cs-copy { font-size: 11px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 8px; border-radius: 4px; white-space: nowrap; }
.cs-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
.cs-card.resolved { opacity: .7; }
.cs-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.cs-badge.pending { background: var(--vscode-editorWarning-foreground); color: #000; }
.cs-badge.resolved { background: var(--vscode-charts-green, #73c991); color: #000; }
.cs-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.cs-author { font-weight: 600; font-size: 12px; }
.cs-comment { font-size: 13px; margin: 4px 0; white-space: pre-wrap; }
.cs-actions { display: flex; gap: 8px; margin-top: 8px; }
.cs-actions button { font-size: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 4px; }
.cs-empty { color: var(--vscode-descriptionForeground); font-size: 13px; }
#cs-add { position: fixed; z-index: 10; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let items = JSON.parse(document.getElementById('cs-items').textContent || '[]');
const content = document.getElementById('cs-content');
const addBtn = document.getElementById('cs-add');
const list = document.getElementById('cs-list');
document.getElementById('cs-copy').addEventListener('click', () => vscode.postMessage({ type: 'copyPrompt' }));

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'updateComments') {
    items = message.items;
    renderComments();
  }
});

content.addEventListener('click', e => {
  let target = e.target;
  while (target && target !== content) {
    if (target.classList.contains('cs-hl') && target.dataset.commentId) {
      focusCard(target.dataset.commentId);
      return;
    }
    target = target.parentElement;
  }
});

function blocks() { return Array.from(content.querySelectorAll('[data-line]')); }

function elementsForRange(start0, endExcl) {
  return blocks().filter(el => {
    const s = +el.dataset.line, e = +el.dataset.lineEnd;
    return s < endExcl && e > start0; // overlap
  });
}

// Highlight commented ranges and build the comments sidebar.
function renderComments() {
  blocks().forEach(el => {
    el.classList.remove('cs-hl', 'cs-hl-pending', 'cs-hl-resolved');
    delete el.dataset.commentId;
  });
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<div class="cs-empty">No comments yet. Select text to add one.</div>'; return; }
  items.forEach(item => {
    const start0 = (item.startLine || 1) - 1;
    const endExcl = (item.endLine || item.startLine || 1);
    elementsForRange(start0, endExcl).forEach(el => {
      el.classList.add('cs-hl', item.status === 'resolved' ? 'cs-hl-resolved' : 'cs-hl-pending');
      el.dataset.commentId = item.id;
    });

    const card = document.createElement('div');
    card.className = 'cs-card ' + (item.status === 'resolved' ? 'resolved' : '');
    card.id = 'card-' + item.id;
    const comments = item.comments.map(c =>
      '<div class="cs-comment"><span class="cs-author">' + esc(c.author) + ':</span> ' + esc(c.text) + '</div>'
    ).join('');
    const nextStatus = item.status === 'resolved' ? 'pending' : 'resolved';
    const nextLabel = item.status === 'resolved' ? 'Reopen' : 'Resolve';
    card.innerHTML =
      '<div class="cs-meta"><span class="cs-lines">Lines ' + (item.startLine||'?') + '-' + (item.endLine||'?') + '</span>' +
      '<span class="cs-badge ' + item.status + '">' + item.status + '</span></div>' +
      comments +
      '<div class="cs-actions"><button data-act="reply">Reply</button>' +
      '<button data-act="status">' + nextLabel + '</button></div>';
    card.querySelector('[data-act="reply"]').addEventListener('click', () => vscode.postMessage({ type: 'reply', id: item.id }));
    card.querySelector('[data-act="status"]').addEventListener('click', () => vscode.postMessage({ type: 'setStatus', id: item.id, status: nextStatus }));
    card.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') scrollToRange(start0, endExcl); });
    list.appendChild(card);
  });
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

// Preserve scroll position across the full-HTML refreshes.
const prev = vscode.getState();
if (prev && typeof prev.scrollY === 'number') { setTimeout(() => window.scrollTo(0, prev.scrollY), 0); }
window.addEventListener('scroll', () => vscode.setState({ scrollY: window.scrollY }));

renderComments();
`;
