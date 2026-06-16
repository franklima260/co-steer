import * as vscode from 'vscode';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Serves the "pre-iteration" snapshot of an artifact so the diff command can show
 * what the agent actually changed. The left-hand (base) side of the diff reads from
 * this provider; the right-hand side reads the live file. Without a snapshot, diffing
 * a file against itself would always be empty.
 */
export class SnapshotProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'ai-review-base';

    private snapshots = new Map<string, string>();
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    /** Capture the current on-disk content of a file as its pre-iteration baseline. */
    public capture(filePath: string): void {
        try {
            const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
            this.snapshots.set(filePath, content);
            logger.info('SnapshotProvider: captured baseline', { filePath, bytes: content.length });
            this._onDidChange.fire(vscode.Uri.file(filePath).with({ scheme: SnapshotProvider.scheme }));
        } catch (err: any) {
            logger.counter('snapshot.capture', { outcome: 'error' });
            logger.error('SnapshotProvider: failed to capture baseline', { error: err.message, filePath });
        }
    }

    public hasSnapshot(filePath: string): boolean {
        return this.snapshots.has(filePath);
    }

    /** Drop a baseline once its artifact is approved/closed, freeing memory. */
    public clear(filePath: string): void {
        this.snapshots.delete(filePath);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const filePath = uri.fsPath;
        if (this.snapshots.has(filePath)) {
            logger.counter('snapshot.provide', { outcome: 'hit' });
            return this.snapshots.get(filePath)!;
        }
        // No snapshot yet: fall back to current disk content so the diff is empty
        // rather than erroring.
        logger.counter('snapshot.provide', { outcome: 'miss' });
        try {
            return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        } catch (err: any) {
            logger.error('SnapshotProvider: fallback read failed', { error: err.message, filePath });
            return '';
        }
    }
}
