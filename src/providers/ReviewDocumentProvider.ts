import * as vscode from 'vscode';
import * as fs from 'fs';
import { logger } from '../utils/logger';

export class ReviewDocumentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'ai-review';

    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    public update(uri: vscode.Uri) {
        logger.debug('ReviewDocumentProvider: triggering update', { uri: uri.toString() });
        this._onDidChange.fire(uri);
    }

    public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const filePath = uri.fsPath;
        logger.debug('ReviewDocumentProvider: providing content', { filePath });
        const startTime = Date.now();
        try {
            if (fs.existsSync(filePath)) {
                const content = await fs.promises.readFile(filePath, 'utf8');
                logger.counter('review_doc.provide', { outcome: 'success' });
                logger.histogram('review_doc.read_duration_ms', Date.now() - startTime, { filePath });
                return content;
            }
            logger.counter('review_doc.provide', { outcome: 'file_not_found' });
            logger.warn('ReviewDocumentProvider: file not found', { filePath });
            return `File not found: ${filePath}`;
        } catch (err: any) {
            logger.counter('review_doc.provide', { outcome: 'error' });
            logger.error('ReviewDocumentProvider: error reading file', { error: err.message, filePath });
            return `Error reading file: ${err.message}`;
        }
    }
}

