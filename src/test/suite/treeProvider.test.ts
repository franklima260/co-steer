import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactTreeProvider } from '../../providers/ArtifactTreeProvider';
import { ArtifactStateStore } from '../../state/ArtifactStateStore';

suite('ArtifactTreeProvider Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const sidecarPath = path.join(testFixturesPath, 'test.js.review.md');

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(sidecarPath, '# Pending Review\n<review_item status="pending">\n</review_item>', 'utf8');
    });

    teardown(() => {
        if (fs.existsSync(sidecarPath)) {
            fs.unlinkSync(sidecarPath);
        }
    });

    test('getChildren returns review files', async () => {
        const provider = new ArtifactTreeProvider();
        const children = await provider.getChildren();

        assert.ok(children.length > 0, 'Should find at least one review file');
        const item = children.find(c => c.originalUri?.fsPath.endsWith('test.js'));
        assert.ok(item, 'Should find test.js artifact');
        assert.strictEqual(item?.command?.command, 'vscode.open');
    });

    test('item state reflects pending review items in the sidecar', async () => {
        const provider = new ArtifactTreeProvider();
        const children = await provider.getChildren();
        const item = children.find(c => c.originalUri?.fsPath.endsWith('test.js'));
        assert.ok(item, 'Should find test.js artifact');
        assert.strictEqual(item!.state, 'pending');
        assert.strictEqual(item!.pendingCount, 1);
        assert.ok((item!.description as string).includes('(1)'), 'description shows pending count');
    });

    test('item state is resolved when no pending items remain', async () => {
        fs.writeFileSync(sidecarPath, '<review_item status="resolved">\n</review_item>', 'utf8');
        const provider = new ArtifactTreeProvider();
        const children = await provider.getChildren();
        const item = children.find(c => c.originalUri?.fsPath.endsWith('test.js'));
        assert.ok(item, 'Should find test.js artifact');
        assert.strictEqual(item!.state, 'resolved');
    });

    test('iterating state from the store overrides sidecar-derived state', async () => {
        const store = new ArtifactStateStore();
        const originalPath = path.join(testFixturesPath, 'test.js');
        store.set(originalPath, 'iterating');
        const provider = new ArtifactTreeProvider(store);
        const children = await provider.getChildren();
        const item = children.find(c => c.originalUri?.fsPath.endsWith('test.js'));
        assert.ok(item, 'Should find test.js artifact');
        assert.strictEqual(item!.state, 'iterating');
        store.dispose();
    });
});
