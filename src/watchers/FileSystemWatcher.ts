import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export type ReviewFileEvent = 'create' | 'change' | 'delete';

export function createReviewWatcher(onReviewFileChanged: (uri: vscode.Uri, event: ReviewFileEvent) => void) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.review.md');

    watcher.onDidCreate((uri) => {
        logger.info('watcher: review file created', { file: uri.fsPath });
        logger.counter('watcher.event', { type: 'create' });
        onReviewFileChanged(uri, 'create');
    });
    watcher.onDidChange((uri) => {
        logger.info('watcher: review file changed', { file: uri.fsPath });
        logger.counter('watcher.event', { type: 'change' });
        onReviewFileChanged(uri, 'change');
    });
    watcher.onDidDelete((uri) => {
        logger.info('watcher: review file deleted', { file: uri.fsPath });
        logger.counter('watcher.event', { type: 'delete' });
        onReviewFileChanged(uri, 'delete');
    });

    logger.info('FileSystemWatcher: initialized for **/*.review.md');
    return watcher;
}
