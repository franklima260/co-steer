import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import {
    ReviewItem,
    parseReviewItems,
    buildSidecarContent,
    generateReviewId
} from '../utils/sidecar';

/**
 * Renders inline review threads from the `.review.md` sidecar and keeps them in sync.
 *
 * The sidecar is the single source of truth shared by humans (who comment via the gutter)
 * and agents (who edit the sidecar directly). The editor gutter is a pure projection of
 * the sidecar: adding a human comment appends to the sidecar and re-renders; when an agent
 * flips a `<review_item>` to `status="resolved"` or appends an agent `<comment>`, the
 * sidecar watcher re-renders and the gutter thread's resolved state / comments update to
 * match — no manual reconciliation by the user.
 */
export class ArtifactCommentController {
    private commentController: vscode.CommentController;
    /** sidecarPath -> (review item id -> live thread). */
    private threads = new Map<string, Map<string, vscode.CommentThread>>();

    constructor() {
        this.commentController = vscode.comments.createCommentController('coSteerComments', 'Co-Steer Review');
        this.commentController.options = {
            placeHolder: 'Add instructions for the AI...'
        };
        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument) => {
                if (document.uri.scheme === 'ai-review') {
                    return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
                }
                return [];
            }
        };
    }

    private static sidecarFor(originalFilePath: string): string {
        return `${originalFilePath}.review.md`;
    }

    private static originalFor(sidecarPath: string): string {
        return sidecarPath.replace(/\.review\.md$/, '');
    }

    private static reviewDocUri(originalFilePath: string): vscode.Uri {
        return vscode.Uri.file(originalFilePath).with({ scheme: 'ai-review' });
    }

    private threadMap(sidecarPath: string): Map<string, vscode.CommentThread> {
        let map = this.threads.get(sidecarPath);
        if (!map) {
            map = new Map();
            this.threads.set(sidecarPath, map);
        }
        return map;
    }

    private static toRange(item: ReviewItem): vscode.Range {
        const start = Math.max(0, (item.startLine ?? 1) - 1);
        const end = Math.max(start, (item.endLine ?? item.startLine ?? 1) - 1);
        return new vscode.Range(start, 0, end, 0);
    }

    /** Add a human comment: a reply if the thread already maps to an item, else a new item. */
    public async addComment(reply: vscode.CommentReply) {
        const startTime = Date.now();
        const thread = reply.thread;
        const text = reply.text;
        const docUri = thread.uri;
        const originalFilePath = docUri.fsPath;
        const sidecarPath = ArtifactCommentController.sidecarFor(originalFilePath);
        const fileName = path.basename(originalFilePath);

        logger.info('CommentController: adding comment', { text, uri: docUri.toString() });

        try {
            const existingContent = fs.existsSync(sidecarPath)
                ? await fs.promises.readFile(sidecarPath, 'utf8')
                : '';
            const items = parseReviewItems(existingContent);

            const existingId = this.findThreadId(sidecarPath, thread);
            const existingItem = existingId ? items.find(i => i.id === existingId) : undefined;

            if (existingItem) {
                // Reply to an existing thread: append a comment to that item.
                existingItem.comments.push({ author: 'You', text });
                logger.counter('comment.add', { outcome: 'reply' });
            } else {
                // New item: requires a range to anchor and capture the target code.
                if (!thread.range) {
                    logger.counter('comment.add', { outcome: 'no_range' });
                    logger.warn('CommentController: comment thread has no range', { uri: docUri.toString() });
                    vscode.window.showErrorMessage('Comment thread has no range.');
                    return;
                }
                const targetCode = await this.extractTargetCode(thread, originalFilePath);
                const id = generateReviewId();
                items.push({
                    id,
                    status: 'pending',
                    file: fileName,
                    startLine: thread.range.start.line + 1,
                    endLine: thread.range.end.line + 1,
                    language: path.extname(originalFilePath).substring(1),
                    targetCode,
                    comments: [{ author: 'You', text }]
                });
                // Register the reply's thread under the new id so render reuses it instead
                // of creating a duplicate empty thread.
                this.threadMap(sidecarPath).set(id, thread);
                logger.counter('comment.add', { outcome: 'success' });
            }

            await fs.promises.writeFile(sidecarPath, buildSidecarContent(fileName, items), 'utf8');
            this.renderFromSidecar(sidecarPath);

            logger.histogram('comment.add_duration_ms', Date.now() - startTime, { filePath: originalFilePath });
            logger.info('CommentController: comment written and rendered', { sidecarPath });
        } catch (err: any) {
            logger.counter('comment.add', { outcome: 'error' });
            logger.error('CommentController: failed to add comment', { error: err.message, stack: err.stack });
            vscode.window.showErrorMessage(`Failed to add comment: ${err.message}`);
        }
    }

    private async extractTargetCode(thread: vscode.CommentThread, originalFilePath: string): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        if (thread.range && editor && editor.document.uri.toString() === thread.uri.toString()) {
            return editor.document.getText(thread.range);
        }
        if (!fs.existsSync(originalFilePath)) {
            throw new Error(`Target file not found: ${originalFilePath}`);
        }
        const content = await fs.promises.readFile(originalFilePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const start = thread.range ? thread.range.start.line : 0;
        const end = thread.range ? thread.range.end.line : 0;
        return lines.slice(start, end + 1).join('\n');
    }

    private findThreadId(sidecarPath: string, thread: vscode.CommentThread): string | undefined {
        const map = this.threads.get(sidecarPath);
        if (!map) {
            return undefined;
        }
        for (const [id, t] of map) {
            if (t === thread) {
                return id;
            }
        }
        return undefined;
    }

    /**
     * Reconcile the gutter threads for a sidecar against its current on-disk contents.
     * Creates threads for new items, updates comments + resolved state for existing ones,
     * and disposes threads whose items were removed.
     */
    public renderFromSidecar(sidecarPath: string): void {
        const startTime = Date.now();
        const originalFilePath = ArtifactCommentController.originalFor(sidecarPath);
        const docUri = ArtifactCommentController.reviewDocUri(originalFilePath);

        let content = '';
        try {
            if (fs.existsSync(sidecarPath)) {
                content = fs.readFileSync(sidecarPath, 'utf8');
            }
        } catch (err: any) {
            logger.counter('comment.render', { outcome: 'read_error' });
            logger.error('CommentController: failed to read sidecar for render', { error: err.message, sidecarPath });
            return;
        }

        const items = parseReviewItems(content);
        const map = this.threadMap(sidecarPath);
        const seen = new Set<string>();

        for (const item of items) {
            seen.add(item.id);
            const range = ArtifactCommentController.toRange(item);
            let thread = map.get(item.id);
            if (!thread) {
                thread = this.commentController.createCommentThread(docUri, range, []);
                map.set(item.id, thread);
            }
            thread.range = range;
            thread.comments = item.comments.map(c =>
                new ArtifactComment(new vscode.MarkdownString(c.text), vscode.CommentMode.Preview, { name: c.author }, thread)
            );
            thread.canReply = true;
            thread.contextValue = item.status;
            if (item.status === 'resolved') {
                thread.state = vscode.CommentThreadState.Resolved;
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
                thread.label = 'Resolved';
            } else {
                thread.state = vscode.CommentThreadState.Unresolved;
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
                thread.label = undefined;
            }
        }

        // Dispose threads whose items no longer exist in the sidecar.
        for (const [id, thread] of map) {
            if (!seen.has(id)) {
                thread.dispose();
                map.delete(id);
            }
        }

        logger.counter('comment.render', { outcome: 'success', items: items.length });
        logger.histogram('comment.render_duration_ms', Date.now() - startTime, { sidecarPath });
    }

    /** Tear down all threads for a sidecar (e.g. after approval deletes it). */
    public disposeSidecar(sidecarPath: string): void {
        const map = this.threads.get(sidecarPath);
        if (!map) {
            return;
        }
        for (const thread of map.values()) {
            thread.dispose();
        }
        this.threads.delete(sidecarPath);
        logger.info('CommentController: disposed threads for sidecar', { sidecarPath });
    }

    /** Test/diagnostic accessor: live threads for a sidecar. */
    public threadsFor(sidecarPath: string): vscode.CommentThread[] {
        return Array.from(this.threads.get(sidecarPath)?.values() ?? []);
    }

    public dispose() {
        for (const map of this.threads.values()) {
            for (const thread of map.values()) {
                thread.dispose();
            }
        }
        this.threads.clear();
        this.commentController.dispose();
    }
}

class ArtifactComment implements vscode.Comment {
    constructor(
        public body: string | vscode.MarkdownString,
        public mode: vscode.CommentMode,
        public author: vscode.CommentAuthorInformation,
        public parent?: vscode.CommentThread,
        public contextValue?: string
    ) {}
}
