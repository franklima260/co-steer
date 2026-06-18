import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as os from 'os';
import { ArtifactTreeProvider, ArtifactItem } from './providers/ArtifactTreeProvider';
import { ReviewDocumentProvider } from './providers/ReviewDocumentProvider';
import { SnapshotProvider } from './providers/SnapshotProvider';
import { ArtifactCommentController } from './controllers/CommentController';
import { createReviewWatcher } from './watchers/FileSystemWatcher';
import { ArtifactStateStore } from './state/ArtifactStateStore';
import { runAsPrompt } from './agent/promptRunner';
import { buildAgentSpawn } from './agent/spawn';
import { buildReviewPrompt } from './agent/reviewPrompt';
import { MarkdownReviewPanel } from './panels/MarkdownReviewPanel';
import { openLinkHelper } from './utils/openLink';
import { logger } from './utils/logger';

import { checkAndPromptWorkspaceRules } from './agent/workspaceRules';
import { injectPointer, removePointer } from './utils/pointerInjector';

export function activate(context: vscode.ExtensionContext) {
    logger.info('Co-Steer is activating');

    // Check workspace rules for agents
    checkAndPromptWorkspaceRules(context);

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
        MarkdownReviewPanel.notifyChanged(uri.fsPath);
    });
    context.subscriptions.push(watcher);
    context.subscriptions.push({ dispose: () => MarkdownReviewPanel.disposeAll() });

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

    const handlePhysicalFileChange = (uri: vscode.Uri) => {
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
            MarkdownReviewPanel.notifyChanged(filePath);
        }, REFRESH_DEBOUNCE_MS));
    };

    physicalFileWatcher.onDidChange(handlePhysicalFileChange);
    physicalFileWatcher.onDidCreate(handlePhysicalFileChange);
    physicalFileWatcher.onDidDelete(handlePhysicalFileChange);
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

    // Open an existing artifact in the right reviewer: rendered panel for markdown,
    // read-only text view otherwise. Used by the tree items.
    const openArtifact = async (originalFilePath: string) => {
        if (/\.(md|markdown)$/i.test(originalFilePath)) {
            MarkdownReviewPanel.show(originalFilePath);
        } else {
            const reviewUri = vscode.Uri.file(originalFilePath).with({ scheme: ReviewDocumentProvider.scheme });
            await vscode.window.showTextDocument(reviewUri, { preview: false });
            commentController.renderFromSidecar(`${originalFilePath}.review.md`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('co-steer.open', (arg?: vscode.Uri | ArtifactItem) => {
        const fsPath = arg instanceof vscode.Uri ? arg.fsPath : arg?.originalUri?.fsPath;
        if (fsPath) {
            return openArtifact(fsPath);
        }
    }));

    // Copy the canonical "act on the sidecar" instruction to the clipboard, to paste into a
    // chat-based agent (e.g. the host IDE's assistant) that isn't a configurable CLI.
    const resolveArtifactPath = (arg?: vscode.Uri | ArtifactItem): string | undefined => {
        let fsPath = arg instanceof vscode.Uri ? arg.fsPath : arg?.originalUri?.fsPath;
        if (!fsPath && vscode.window.activeTextEditor) {
            fsPath = vscode.window.activeTextEditor.document.uri.fsPath;
        }
        if (fsPath?.endsWith('.review.md')) {
            fsPath = fsPath.replace(/\.review\.md$/, '');
        }
        return fsPath;
    };
    context.subscriptions.push(vscode.commands.registerCommand('co-steer.copyPrompt', async (arg?: vscode.Uri | ArtifactItem) => {
        const fsPath = resolveArtifactPath(arg);
        if (!fsPath) {
            logger.counter('co-steer.copyPrompt', { outcome: 'no_file' });
            vscode.window.showWarningMessage('Select an artifact (or open a file) to copy its agent prompt.');
            return;
        }
        const prompt = buildReviewPrompt({
            artifactPath: vscode.workspace.asRelativePath(fsPath),
            sidecarPath: vscode.workspace.asRelativePath(`${fsPath}.review.md`)
        });
        await vscode.env.clipboard.writeText(prompt);
        logger.counter('co-steer.copyPrompt', { outcome: 'success' });
        vscode.window.showInformationMessage('Co-Steer: agent prompt copied — paste it to your AI agent.');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('co-steer.sendPromptToAntigravity', async (arg?: vscode.Uri | ArtifactItem) => {
        const fsPath = resolveArtifactPath(arg);
        if (!fsPath) {
            logger.counter('co-steer.sendPromptToAntigravity', { outcome: 'no_file' });
            vscode.window.showWarningMessage('Select an artifact (or open a file) to send its agent prompt.');
            return;
        }
        const prompt = buildReviewPrompt({
            artifactPath: vscode.workspace.asRelativePath(fsPath),
            sidecarPath: vscode.workspace.asRelativePath(`${fsPath}.review.md`)
        });

        try {
            logger.info('Sending prompt to Antigravity agent panel');
            await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
            logger.counter('co-steer.sendPromptToAntigravity', { outcome: 'success' });
            vscode.window.showInformationMessage('Co-Steer: Prompt sent to Antigravity Agent Panel.');
        } catch (err: any) {
            logger.counter('co-steer.sendPromptToAntigravity', { outcome: 'fallback_clipboard', error: err.message });
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showWarningMessage('Antigravity agent panel not active. Prompt copied to clipboard instead.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('co-steer.sendPromptToClaude', async (arg?: vscode.Uri | ArtifactItem) => {
        const fsPath = resolveArtifactPath(arg);
        if (!fsPath) {
            logger.counter('co-steer.sendPromptToClaude', { outcome: 'no_file' });
            vscode.window.showWarningMessage('Select an artifact (or open a file) to send its agent prompt.');
            return;
        }
        const prompt = buildReviewPrompt({
            artifactPath: vscode.workspace.asRelativePath(fsPath),
            sidecarPath: vscode.workspace.asRelativePath(`${fsPath}.review.md`)
        });

        try {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
            const workspaceRoot = folder ? folder.uri.fsPath : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(fsPath));

            let sessionId: string | undefined;
            try {
                sessionId = await getActiveClaudeSessionId(workspaceRoot);
            } catch (sessionErr: any) {
                logger.warn('Failed to resolve active Claude session ID', { error: sessionErr.message });
            }

            logger.info('Sending prompt to Claude', { promptLength: prompt.length, hasSession: !!sessionId });

            if (sessionId) {
                // Claude Code's URI handler (/open) starts a new session and cannot inject a
                // prompt into an already-open one — it shows "Session is already open. Your
                // prompt was not applied." Copy to clipboard so the user can paste it directly.
                await vscode.env.clipboard.writeText(prompt);
                logger.counter('co-steer.sendPromptToClaude', { outcome: 'clipboard_active_session', hasSession: true });
                vscode.window.showInformationMessage('Co-Steer: Prompt copied to clipboard — paste it into the open Claude Code session.');
            } else {
                const scheme = vscode.env.uriScheme;
                const uri = vscode.Uri.parse(`${scheme}://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`);
                await openLinkHelper.openExternal(uri);
                logger.counter('co-steer.sendPromptToClaude', { outcome: 'success_uri', hasSession: false });
            }
        } catch (err: any) {
            logger.counter('co-steer.sendPromptToClaude', { outcome: 'error', error: err.message });
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showWarningMessage('Failed to send prompt to Claude. Prompt copied to clipboard instead.');
        }
    }));

    // Entry point: start reviewing a file. Creates the sidecar (so it shows in the panel),
    // opens the read-only ai-review view, and makes the commenting gutter available.
    context.subscriptions.push(vscode.commands.registerCommand('co-steer.reviewFile', async (uriArg?: vscode.Uri) => {
        let targetPath: string | undefined;
        if (uriArg?.scheme === 'file') {
            targetPath = uriArg.fsPath;
        } else if (vscode.window.activeTextEditor) {
            // Works for a file:// doc or an already-open ai-review doc (fsPath strips scheme).
            targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
        }
        if (!targetPath) {
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Review' });
            targetPath = picked?.[0]?.fsPath;
        }
        if (!targetPath) {
            logger.counter('co-steer.reviewFile', { outcome: 'no_file' });
            vscode.window.showWarningMessage('Open or pick a file to start a Co-Steer review.');
            return;
        }
        if (targetPath.endsWith('.review.md')) {
            logger.counter('co-steer.reviewFile', { outcome: 'is_sidecar' });
            vscode.window.showWarningMessage('That is a Co-Steer sidecar, not an artifact to review.');
            return;
        }

        const sidecarPath = `${targetPath}.review.md`;
        try {
            if (!fs.existsSync(sidecarPath)) {
                await fs.promises.writeFile(sidecarPath, `# Pending Review Comments for \`${path.basename(targetPath)}\`\n`, 'utf8');
                logger.info('co-steer.reviewFile: created sidecar', { sidecarPath });
            }

            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
                await injectPointer(targetPath, doc.languageId);
            } catch (pointerErr: any) {
                logger.warn('Failed to inject pointer comment', { error: pointerErr.message, targetPath });
                const configAction = 'Configure Syntax';
                vscode.window.showWarningMessage(
                    `Co-Steer: Could not inject sidecar pointer into \`${path.basename(targetPath)}\`. Unknown comment syntax for \`${path.extname(targetPath).replace(/^\./, '') || 'unknown'}\`.`,
                    configAction
                ).then(selection => {
                    if (selection === configAction) {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'co-steer.customCommentSyntaxes');
                    }
                });
            }

            artifactTreeProvider.refresh();
            await openArtifact(targetPath);
            const rendered = /\.(md|markdown)$/i.test(targetPath);
            logger.counter('co-steer.reviewFile', { outcome: 'success', mode: rendered ? 'rendered' : 'text' });
            vscode.window.showInformationMessage(
                rendered
                    ? `Reviewing ${path.basename(targetPath)} (rendered) — select text and click 💬 to comment.`
                    : `Reviewing ${path.basename(targetPath)} — highlight lines and click the + to add a comment.`
            );
        } catch (err: any) {
            logger.counter('co-steer.reviewFile', { outcome: 'error' });
            logger.error('co-steer.reviewFile failed', { error: err.message, targetPath });
            vscode.window.showErrorMessage(`Failed to start review: ${err.message}`);
        }
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

        // Tell the agent to act on the sidecar (not just the bare file). Sent over stdin so
        // CLIs that read a prompt from stdin get full context; the file path is also an arg.
        const reviewPrompt = buildReviewPrompt({
            artifactPath: vscode.workspace.asRelativePath(filePath),
            sidecarPath: vscode.workspace.asRelativePath(`${filePath}.review.md`)
        });
        child.stdin?.end(reviewPrompt);

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
             try {
                 await removePointer(originalFilePath);
             } catch (pointerErr: any) {
                 logger.warn('Failed to remove pointer comment', { error: pointerErr.message, originalFilePath });
             }

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

export interface ClaudeSession {
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
    entrypoint: string;
}

export function normalizePathForComparison(p: string): string {
    return path.normalize(p).toLowerCase().replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

export async function getActiveClaudeSessionId(workspaceRoot: string, homeDirOverride?: string): Promise<string | undefined> {
    const homeDir = homeDirOverride || process.env.CO_STEER_TEST_HOME || os.homedir();
    const sessionsDir = path.join(homeDir, '.claude', 'sessions');
    if (!fs.existsSync(sessionsDir)) {
        return undefined;
    }

    const targetCwdNormalized = normalizePathForComparison(workspaceRoot);
    let files: string[];
    try {
        files = await fs.promises.readdir(sessionsDir);
    } catch (err) {
        return undefined;
    }

    const sessions: ClaudeSession[] = [];
    for (const file of files) {
        if (!file.endsWith('.json')) {
            continue;
        }
        try {
            const filePath = path.join(sessionsDir, file);
            const content = await fs.promises.readFile(filePath, 'utf8');
            const data = JSON.parse(content) as ClaudeSession;
            if (data && typeof data.sessionId === 'string' && typeof data.cwd === 'string') {
                sessions.push(data);
            }
        } catch (err) {
            // ignore malformed/unreadable session files
        }
    }

    // Filter by matching cwd
    const matchingSessions = sessions.filter(s => normalizePathForComparison(s.cwd) === targetCwdNormalized);
    if (matchingSessions.length === 0) {
        return undefined;
    }

    // Check if PID is alive
    const isPidAlive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return false;
        }
    };

    // 1. Look for alive claude-vscode sessions
    const aliveVscodeSessions = matchingSessions.filter(s => s.entrypoint === 'claude-vscode' && isPidAlive(s.pid));
    if (aliveVscodeSessions.length > 0) {
        aliveVscodeSessions.sort((a, b) => b.startedAt - a.startedAt);
        return aliveVscodeSessions[0].sessionId;
    }

    // 2. Look for any alive sessions
    const aliveSessions = matchingSessions.filter(s => isPidAlive(s.pid));
    if (aliveSessions.length > 0) {
        aliveSessions.sort((a, b) => b.startedAt - a.startedAt);
        return aliveSessions[0].sessionId;
    }

    // 3. Fallback: most recently started session matching the workspace
    matchingSessions.sort((a, b) => b.startedAt - a.startedAt);
    return matchingSessions[0].sessionId;
}

