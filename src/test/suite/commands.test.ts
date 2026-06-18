import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ArtifactItem } from '../../providers/ArtifactTreeProvider';
import { openLinkHelper } from '../../utils/openLink';
import { getActiveClaudeSessionId } from '../../extension';

suite('Commands Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const testFilePath = path.join(testFixturesPath, 'cmdTest.js');
    const sidecarPath = `${testFilePath}.review.md`;

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(testFilePath, '// code', 'utf8');
        fs.writeFileSync(sidecarPath, '# sidecar', 'utf8');
    });

    teardown(() => {
        if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
    });

    test('co-steer.approve deletes sidecar file', async () => {
        const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
        
        await vscode.commands.executeCommand('co-steer.approve', item);

        // approve awaits fs.promises.unlink internally, so by the time executeCommand
        // resolves the sidecar is already gone — no timing wait needed.
        assert.strictEqual(fs.existsSync(sidecarPath), false, 'Sidecar should be deleted');
    });

    test('co-steer.iterate with no agentCommand mocks success without throwing', async () => {
        // No co-steer.agentCommand is configured in the test workspace, so iterate must
        // take the mock path and complete without spawning a process or throwing.
        const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
        await vscode.commands.executeCommand('co-steer.iterate', item);
        // The original file must be untouched by the mock path.
        assert.strictEqual(fs.readFileSync(testFilePath, 'utf8'), '// code');
    });

    test('co-steer.reviewFile on a markdown file runs end-to-end and seeds a sidecar', async () => {
        const mdPath = path.join(testFixturesPath, 'reviewCmd.md');
        const mdSidecar = `${mdPath}.review.md`;
        fs.writeFileSync(mdPath, '# Heading\n\nbody', 'utf8');
        try {
            // Passing the uri exercises the full command path including the markdown branch
            // (which opens the rendered webview panel).
            await vscode.commands.executeCommand('co-steer.reviewFile', vscode.Uri.file(mdPath));
            assert.ok(fs.existsSync(mdSidecar), 'reviewFile should create the sidecar so the artifact is tracked');
        } finally {
            if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
            if (fs.existsSync(mdSidecar)) fs.unlinkSync(mdSidecar);
        }
    });

    test('co-steer.sendPromptToAntigravity and co-steer.sendPromptToClaude commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('co-steer.sendPromptToAntigravity'), 'sendPromptToAntigravity command should be registered');
        assert.ok(commands.includes('co-steer.sendPromptToClaude'), 'sendPromptToClaude command should be registered');
    });

    test('co-steer.sendPromptToAntigravity invokes antigravity command when registered', async () => {
        let receivedPrompt: string | undefined;
        const mockDisposable = vscode.commands.registerCommand('antigravity.sendPromptToAgentPanel', (prompt: string) => {
            receivedPrompt = prompt;
        });

        try {
            const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
            await vscode.commands.executeCommand('co-steer.sendPromptToAntigravity', item);
            assert.ok(receivedPrompt, 'Should have received prompt');
            assert.ok(receivedPrompt.includes('cmdTest.js'), 'Prompt should reference the artifact path');
        } finally {
            mockDisposable.dispose();
        }
    });

    test('co-steer.sendPromptToAntigravity copies to clipboard as fallback if not registered', async () => {
        // Clear clipboard
        await vscode.env.clipboard.writeText('');

        const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
        await vscode.commands.executeCommand('co-steer.sendPromptToAntigravity', item);

        const clipboardText = await vscode.env.clipboard.readText();
        assert.ok(clipboardText.includes('Read `cmdTest.js.review.md`'), 'Prompt should be copied to clipboard');
    });

    test('co-steer.sendPromptToClaude opens deep link using openLinkHelper (without session)', async () => {
        let openedUri: vscode.Uri | undefined;
        (globalThis as any).__mockOpenExternal = async (uri: vscode.Uri) => {
            openedUri = uri;
            return true;
        };

        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-home-empty-'));
        process.env.CO_STEER_TEST_HOME = tmpHome;

        try {
            const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
            await vscode.commands.executeCommand('co-steer.sendPromptToClaude', item);
            assert.ok(openedUri, 'openExternal should have been called');
            assert.strictEqual(openedUri.scheme, vscode.env.uriScheme, 'Scheme should match vscode.env.uriScheme');
            assert.strictEqual(openedUri.authority, 'anthropic.claude-code', 'Authority should be anthropic.claude-code');
            assert.strictEqual(openedUri.path, '/open', 'Path should be /open');
            assert.ok(openedUri.query.includes('prompt='), 'Query should contain prompt parameter');
            assert.strictEqual(openedUri.query.includes('&session='), false, 'Query should NOT contain session parameter when no sessions exist');
        } finally {
            delete (globalThis as any).__mockOpenExternal;
            delete process.env.CO_STEER_TEST_HOME;
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    test('co-steer.sendPromptToClaude copies prompt to clipboard when a session is already active', async () => {
        // Regression test: Claude Code's /open URI handler shows "Session is already open.
        // Your prompt was not applied." when a session exists. Co-Steer must copy to clipboard
        // instead of opening the URI to avoid this error.
        let openedUri: vscode.Uri | undefined;
        (globalThis as any).__mockOpenExternal = async (uri: vscode.Uri) => {
            openedUri = uri;
            return true;
        };

        await vscode.env.clipboard.writeText('');

        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-home-filled-'));
        const sessionsDir = path.join(tmpHome, '.claude', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });

        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(testFilePath));
        const workspaceRoot = folder ? folder.uri.fsPath : path.dirname(testFilePath);

        const aliveVscodeSession = {
            pid: process.pid,
            sessionId: 'test-real-session-id',
            cwd: workspaceRoot,
            startedAt: Date.now(),
            entrypoint: 'claude-vscode'
        };
        fs.writeFileSync(path.join(sessionsDir, 'session.json'), JSON.stringify(aliveVscodeSession), 'utf8');

        process.env.CO_STEER_TEST_HOME = tmpHome;

        try {
            const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
            await vscode.commands.executeCommand('co-steer.sendPromptToClaude', item);

            assert.strictEqual(openedUri, undefined, 'openExternal must NOT be called when a session is active — it triggers the "Session is already open" error');

            const clipboardText = await vscode.env.clipboard.readText();
            assert.ok(clipboardText.includes('Read `cmdTest.js.review.md`'), 'Prompt should be in clipboard so user can paste into the active session');
        } finally {
            delete (globalThis as any).__mockOpenExternal;
            delete process.env.CO_STEER_TEST_HOME;
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    test('getActiveClaudeSessionId: returns undefined when sessions directory does not exist', async () => {
        const fakeHome = path.join(os.tmpdir(), `claude-home-none-${Date.now()}`);
        const sessionId = await getActiveClaudeSessionId(__dirname, fakeHome);
        assert.strictEqual(sessionId, undefined, 'Should be undefined if no sessions dir exists');
    });

    test('getActiveClaudeSessionId: reads session files and targets correctly', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-home-'));
        const sessionsDir = path.join(tmpHome, '.claude', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });

        const workspaceRoot = __dirname;

        const deadSession = {
            pid: 999999,
            sessionId: 'dead-session-id',
            cwd: workspaceRoot,
            startedAt: Date.now() - 10000,
            entrypoint: 'claude-vscode'
        };
        fs.writeFileSync(path.join(sessionsDir, 'dead.json'), JSON.stringify(deadSession), 'utf8');

        const aliveCliSession = {
            pid: process.pid,
            sessionId: 'alive-cli-session-id',
            cwd: workspaceRoot,
            startedAt: Date.now() - 5000,
            entrypoint: 'claude-cli'
        };
        fs.writeFileSync(path.join(sessionsDir, 'cli.json'), JSON.stringify(aliveCliSession), 'utf8');

        const aliveVscodeOlderSession = {
            pid: process.pid,
            sessionId: 'alive-vscode-older-session-id',
            cwd: workspaceRoot,
            startedAt: Date.now() - 2000,
            entrypoint: 'claude-vscode'
        };
        fs.writeFileSync(path.join(sessionsDir, 'vscode-older.json'), JSON.stringify(aliveVscodeOlderSession), 'utf8');

        const aliveVscodeNewerSession = {
            pid: process.pid,
            sessionId: 'alive-vscode-newer-session-id',
            cwd: workspaceRoot,
            startedAt: Date.now(),
            entrypoint: 'claude-vscode'
        };
        fs.writeFileSync(path.join(sessionsDir, 'vscode-newer.json'), JSON.stringify(aliveVscodeNewerSession), 'utf8');

        try {
            const sessionId = await getActiveClaudeSessionId(workspaceRoot, tmpHome);
            assert.strictEqual(sessionId, 'alive-vscode-newer-session-id');

            fs.unlinkSync(path.join(sessionsDir, 'vscode-newer.json'));
            const sessionId2 = await getActiveClaudeSessionId(workspaceRoot, tmpHome);
            assert.strictEqual(sessionId2, 'alive-vscode-older-session-id');

            fs.unlinkSync(path.join(sessionsDir, 'vscode-older.json'));
            const sessionId3 = await getActiveClaudeSessionId(workspaceRoot, tmpHome);
            assert.strictEqual(sessionId3, 'alive-cli-session-id');

            fs.unlinkSync(path.join(sessionsDir, 'cli.json'));
            const sessionId4 = await getActiveClaudeSessionId(workspaceRoot, tmpHome);
            assert.strictEqual(sessionId4, 'dead-session-id');
        } finally {
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    test('co-steer.iterate with real agentCommand spawns process and runs it successfully', async () => {
        const config = vscode.workspace.getConfiguration('co-steer');
        await config.update('agentCommand', process.execPath, vscode.ConfigurationTarget.Global);
        await config.update('agentArgs', ['-e', 'process.exit(0);'], vscode.ConfigurationTarget.Global);

        try {
            const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
            await vscode.commands.executeCommand('co-steer.iterate', item);
        } finally {
            await config.update('agentCommand', undefined, vscode.ConfigurationTarget.Global);
            await config.update('agentArgs', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('co-steer.iterate handles nonzero exit code from real agent process', async () => {
        const config = vscode.workspace.getConfiguration('co-steer');
        await config.update('agentCommand', process.execPath, vscode.ConfigurationTarget.Global);
        await config.update('agentArgs', ['-e', 'process.exit(1);'], vscode.ConfigurationTarget.Global);

        try {
            const item = new ArtifactItem('cmdTest.js', vscode.TreeItemCollapsibleState.None, undefined, vscode.Uri.file(testFilePath));
            await vscode.commands.executeCommand('co-steer.iterate', item);
        } finally {
            await config.update('agentCommand', undefined, vscode.ConfigurationTarget.Global);
            await config.update('agentArgs', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
