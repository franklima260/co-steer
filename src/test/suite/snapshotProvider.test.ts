import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotProvider } from '../../providers/SnapshotProvider';

suite('SnapshotProvider Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const testFilePath = path.join(testFixturesPath, 'snap.js');

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(testFilePath, 'const before = 1;', 'utf8');
    });

    teardown(() => {
        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }
    });

    // Regression test for the P0 bug: building the URI with Uri.parse(`scheme://${winPath}`)
    // mangles Windows paths (drive letter becomes the authority). Uri.file().with() must
    // round-trip back to the exact original path.
    test('scheme URI built from file path round-trips to the original fsPath', () => {
        const uri = vscode.Uri.file(testFilePath).with({ scheme: SnapshotProvider.scheme });
        assert.strictEqual(uri.scheme, SnapshotProvider.scheme);
        assert.strictEqual(uri.fsPath, testFilePath);
    });

    test('captured baseline is served even after the file changes on disk', () => {
        const provider = new SnapshotProvider();
        provider.capture(testFilePath);
        assert.strictEqual(provider.hasSnapshot(testFilePath), true);

        // Simulate the agent overwriting the file.
        fs.writeFileSync(testFilePath, 'const after = 2;', 'utf8');

        const uri = vscode.Uri.file(testFilePath).with({ scheme: SnapshotProvider.scheme });
        assert.strictEqual(provider.provideTextDocumentContent(uri), 'const before = 1;',
            'Snapshot must return the pre-iteration content, not the live file');
    });

    test('falls back to current disk content when no snapshot exists', () => {
        const provider = new SnapshotProvider();
        const uri = vscode.Uri.file(testFilePath).with({ scheme: SnapshotProvider.scheme });
        assert.strictEqual(provider.hasSnapshot(testFilePath), false);
        assert.strictEqual(provider.provideTextDocumentContent(uri), 'const before = 1;');
    });
});
