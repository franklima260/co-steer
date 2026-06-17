import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactItem } from '../../providers/ArtifactTreeProvider';

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
});
