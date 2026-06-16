import * as vscode from 'vscode';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { ArtifactTreeProvider, ArtifactItem } from './providers/ArtifactTreeProvider';
import { ReviewDocumentProvider } from './providers/ReviewDocumentProvider';
import { SnapshotProvider } from './providers/SnapshotProvider';
import { ArtifactCommentController } from './controllers/CommentController';
import { createReviewWatcher } from './watchers/FileSystemWatcher';
import { ArtifactStateStore } from './state/ArtifactStateStore';
import { runAsPrompt } from './agent/promptRunner';
import { buildAgentSpawn } from './agent/spawn';
import { logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    logger.info('Co-Steer is activating');

    // Tracks transient per-artifact state (e.g. "iterating").
    const stateStore = new ArtifactStateStore();
    context.subscriptions.push({ dispose: () => stateStore.dispose() });

    // Register Tree Provider
    const artifactTreeProvider = new ArtifactTreeProvider(stateStore);
    vscode.window.registerTreeDataProvider('co-steer-artifacts', artifactTreeProvider);
    logger.info('ArtifactTreeProvider registered');

    // Register Document Provider
    const reviewDocumentProvider = new ReviewDocumentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ReviewDocumentProvider.scheme, reviewDocumentProvider));
    logger.info('ReviewDocumentProvider registered');

    // Register Snapshot Provider (serves the pre-iteration baseline for diffs)
    const snapshotProvider = new SnapshotProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SnapshotProvider.scheme, snapshotProvider));
    logger.info('SnapshotProvider registered');

    // Register Comment Controller
    const commentController = new ArtifactCommentController();
    context.subscriptions.push({ dispose: () => commentController.dispose() });
    logger.info('CommentController registered');

    // File System Watcher: refresh the tree and reconcile gutter comment threads whenever
    // a sidecar changes (a human edit, or an agent resolving/adding comments).
    const watcher = createReviewWatcher((uri, event) => {
        logger.debug('Watcher callback: sidecar event', { file: uri.fsPath, event });
        artifactTreeProvider.refresh();
        if (event === 'delete') {
            commentController.disposeSidecar(uri.fsPath);
        } else {
            commentController.renderFromSidecar(uri.fsPath);
        }
    });
    context.subscriptions.push(watcher);

    // Render existing/agent-authored comments whenever an artifact is opened for review.
    const renderForReviewDoc = (doc?: vscode.TextDocument) => {
        if (doc && doc.uri.scheme === ReviewDocumentProvider.scheme) {
            commentController.renderFromSidecar(`${doc.uri.fsPath}.review.md`);
        }
    };
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(renderForReviewDoc));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => renderForReviewDoc(editor?.document)));
    // Catch any ai-review docs already open at activation.
    for (const editor of vscode.window.visibleTextEditors) {
        renderForReviewDoc(editor.document);
    }

    // Listen to physical file changes to update ai-review virtual docs. We only care about
    // files that are actually under review (i.e. have a sidecar), and we debounce so a burst
    // of agent writes coalesces into a single virtual-document refresh.
    const physicalFileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    const pendingRefreshes = new Map<string, NodeJS.Timeout>();
    const REFRESH_DEBOUNCE_MS = 150;

    physicalFileWatcher.onDidChange(uri => {
        if (uri.scheme !== 'file') {
            return;
        }
        const filePath = uri.fsPath;
        // Skip sidecars themselves and anything not under review.
        if (filePath.endsWith('.review.md') || !fs.existsSync(`${filePath}.review.md`)) {
            return;
        }
        const existing = pendingRefreshes.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }
        pendingRefreshes.set(filePath, setTimeout(() => {
            pendingRefreshes.delete(filePath);
            logger.debug('Physical artifact changed, updating virtual document', { file: filePath });
            reviewDocumentProvider.update(uri.with({ scheme: ReviewDocumentProvider.scheme }));
        }, REFRESH_DEBOUNCE_MS));
    });
    context.subscriptions.push(physicalFileWatcher);
    context.subscriptions.push({
        dispose: () => {
            for (const t of pendingRefreshes.values()) {
                clearTimeout(t);
            }
            pendingRefreshes.clear();
        }
    });

    // Create Comment Command
    context.subscriptions.push(vscode.commands.registerCommand('co-steer.addComment', (reply: vscode.CommentReply) => {
        commentController.addComment(reply);
    }));

    let iterateCmd = vscode.commands.registerCommand('co-steer.iterate', (item?: ArtifactItem) => {
        const filePath = item?.originalUri?.fsPath;
        if (!filePath) {
             logger.counter('co-steer.iterate', { outcome: 'no_file' });
             logger.warn('co-steer.iterate failed: no file path', { itemLabel: item?.label });
             vscode.window.showErrorMessage('No artifact selected for iteration.');
             return;
        }

        // Reject a second iteration while one is already running: two agents writing the
        // same file would race, and re-capturing the baseline mid-write would corrupt the diff.
        if (stateStore.get(filePath) === 'iterating') {
            logger.counter('co-steer.iterate', { outcome: 'already_running' });
            logger.warn('co-steer.iterate ignored: iteration already in progress', { filePath });
            vscode.window.showWarningMessage('An iteration is already running for this artifact.');
            return;
        }

        logger.info('co-steer.iterate starting', { filePath });

        const config = vscode.workspace.getConfiguration('co-steer');
        const agentCommand = config.get<string>('agentCommand')?.trim();
        const agentArgs = config.get<string[]>('agentArgs') ?? [];

        // Capture the pre-iteration baseline so the diff can show what the agent changed.
        snapshotProvider.capture(filePath);

        if (!agentCommand) {
            // No agent configured: this is the Phase 1 mock path. We deliberately do not
            // spawn anything (shell builtins like `echo` are not execFile-able on Windows).
            logger.counter('co-steer.iterate', { outcome: 'mock' });
            logger.info('co-steer.iterate: no agentCommand configured, mocking success', { filePath });
            vscode.window.showInformationMessage('No agent configured (set co-steer.agentCommand). Mock iteration complete.');
            return;
        }

        vscode.window.showInformationMessage(`Iterating on ${item?.label}...`);
        const startTime = Date.now();
        stateStore.set(filePath, 'iterating');

        // The artifact path is passed as the final argument. buildAgentSpawn handles
        // platform differences (Windows .cmd shims) without a shell-injection surface.
        const invocation = buildAgentSpawn(agentCommand, [...agentArgs, filePath]);
        let child: child_process.ChildProcess;
        try {
            child = child_process.spawn(invocation.command, invocation.args, invocation.options);
        } catch (err: any) {
            // spawn can throw synchronously (e.g. EINVAL); make sure we don't leave the
            // artifact stuck in the "iterating" state.
            stateStore.clear(filePath);
            logger.counter('co-steer.iterate', { outcome: 'spawn_throw' });
            logger.error('co-steer.iterate: spawn threw', { error: err.message, command: agentCommand, filePath });
            vscode.window.showErrorMessage(`Failed to launch agent: ${err.message}`);
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            logger.histogram('co-steer.iterate.duration_ms', Date.now() - startTime, { filePath });
            // Drop the transient state so the tree re-derives from the (possibly
            // agent-updated) sidecar contents.
            stateStore.clear(filePath);
            fn();
        };

        child.stdout?.on('data', d => { stdout += d.toString(); });
        child.stderr?.on('data', d => { stderr += d.toString(); });
        child.on('error', err => finish(() => {
            logger.counter('co-steer.iterate', { outcome: 'error' });
            logger.error('co-steer.iterate failed', { error: err.message, stderr, stdout, command: agentCommand, filePath });
            vscode.window.showErrorMessage(`Agent failed: ${err.message}`);
        }));
        child.on('close', code => finish(() => {
            if (code === 0) {
                logger.counter('co-steer.iterate', { outcome: 'success' });
                logger.info('co-steer.iterate complete', { stdout, stderr, filePath });
                vscode.window.showInformationMessage(`Agent iteration complete.`);
            } else {
                logger.counter('co-steer.iterate', { outcome: 'nonzero_exit' });
                logger.error('co-steer.iterate failed', { code, stderr, stdout, command: agentCommand, filePath });
                vscode.window.showErrorMessage(`Agent exited with code ${code}.`);
            }
        }));
    });
    context.subscriptions.push(iterateCmd);

    let diffCmd = vscode.commands.registerCommand('co-steer.diff', async (item?: ArtifactItem) => {
        const originalFilePath = item?.originalUri?.fsPath;
        if (!originalFilePath) {
             logger.counter('co-steer.diff', { outcome: 'no_file' });
             logger.warn('co-steer.diff failed: no original file path');
             return;
        }

        logger.info('co-steer.diff starting', { originalFilePath });
        const start = Date.now();
        try {
             // Left = pre-iteration baseline (snapshot); Right = current on-disk state.
             const baseUri = vscode.Uri.file(originalFilePath).with({ scheme: SnapshotProvider.scheme });
             const currentUri = vscode.Uri.file(originalFilePath).with({ scheme: ReviewDocumentProvider.scheme });
             const relPath = vscode.workspace.asRelativePath(originalFilePath);

             await vscode.commands.executeCommand('vscode.diff', baseUri, currentUri, `Co-Steer Diff: ${relPath} (before ↔ after)`);
             logger.counter('co-steer.diff', { outcome: 'success' });
             logger.histogram('co-steer.diff.duration_ms', Date.now() - start, { originalFilePath });
        } catch (err: any) {
             logger.counter('co-steer.diff', { outcome: 'error' });
             logger.error('co-steer.diff failed', { error: err.message, originalFilePath });
        }
    });
    context.subscriptions.push(diffCmd);

    let approveCmd = vscode.commands.registerCommand('co-steer.approve', async (item?: ArtifactItem) => {
        const originalFilePath = item?.originalUri?.fsPath;
        if (!originalFilePath) {
             logger.counter('co-steer.approve', { outcome: 'no_file' });
             logger.warn('co-steer.approve failed: no original file path');
             return;
        }

        logger.info('co-steer.approve starting', { originalFilePath });
        const sidecarPath = `${originalFilePath}.review.md`;
        
        try {
             let sidecarDeleted = false;
             if (fs.existsSync(sidecarPath)) {
                 await fs.promises.unlink(sidecarPath);
                 sidecarDeleted = true;
             }
             logger.info('co-steer.approve: sidecar checked/deleted', { sidecarPath, sidecarDeleted });

             // Approved: the artifact leaves the review set, so drop any transient state.
             stateStore.clear(originalFilePath);
             snapshotProvider.clear(originalFilePath);
             vscode.window.showInformationMessage(`Artifact Approved! Sidecar deleted.`);

             let promptPiped = false;
             if (originalFilePath.endsWith('.md')) {
                 const result = await vscode.window.showInformationMessage('Artifact Approved. Run as prompt?', 'Yes', 'No');
                 if (result === 'Yes') {
                     const config = vscode.workspace.getConfiguration('co-steer');
                     const agentCommand = config.get<string>('agentCommand')?.trim();
                     const agentArgs = config.get<string[]>('agentArgs') ?? [];
                     const prefix = config.get<string>('promptPrefix') || 'Execute the following approved plan:';
                     promptPiped = await runAsPrompt({ filePath: originalFilePath, agentCommand, agentArgs, prefix });
                 }
             }
             logger.counter('co-steer.approve', { outcome: 'success', promptPiped });
        } catch (err: any) {
             logger.counter('co-steer.approve', { outcome: 'error' });
             logger.error('co-steer.approve failed', { error: err.message, originalFilePath });
        }
    });
    context.subscriptions.push(approveCmd);

    logger.info('Co-Steer is now active!');
}

export function deactivate() {
    logger.info('Co-Steer is deactivating');
    logger.dispose();
}
