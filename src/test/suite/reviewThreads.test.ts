import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactCommentController } from '../../controllers/CommentController';

suite('Sidecar -> thread reconciliation Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const originalPath = path.join(testFixturesPath, 'recon.md');
    const sidecarPath = `${originalPath}.review.md`;

    const item = (id: string, status: string, comments: string) =>
        `<review_item id="${id}" status="${status}">
<location>
File: \`recon.md\`
Lines: 1-2
</location>
<target_code>
\`\`\`md
x
\`\`\`
</target_code>
${comments}
</review_item>`;

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(originalPath, '# title\nbody', 'utf8');
    });

    teardown(() => {
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
    });

    test('maps pending/resolved/accepted/rejected status to native thread resolution state', () => {
        fs.writeFileSync(sidecarPath, [
            item('r-pending', 'pending', '<comment author="You">fix this</comment>'),
            item('r-accepted', 'accepted', '<comment author="You">fix this</comment>'),
            item('r-rejected', 'rejected', '<comment author="You">fix this</comment>'),
            item('r-done', 'resolved', '<comment author="You">fix this</comment>')
        ].join('\n\n'), 'utf8');

        const controller = new ArtifactCommentController();
        controller.renderFromSidecar(sidecarPath);

        const threads = controller.threadsFor(sidecarPath);
        assert.strictEqual(threads.length, 4, 'one thread per review item');

        const states = threads.map(t => t.state).sort();
        const expected = [
            vscode.CommentThreadState.Unresolved,
            vscode.CommentThreadState.Unresolved,
            vscode.CommentThreadState.Resolved,
            vscode.CommentThreadState.Resolved
        ].sort();
        assert.deepStrictEqual(
            states,
            expected,
            'two Unresolved and two Resolved threads'
        );
        controller.dispose();
    });

    test('agent flipping status to resolved updates the SAME thread (stable id)', () => {
        fs.writeFileSync(sidecarPath, item('r-1', 'pending', '<comment author="You">do it</comment>'), 'utf8');
        const controller = new ArtifactCommentController();
        controller.renderFromSidecar(sidecarPath);

        const before = controller.threadsFor(sidecarPath);
        assert.strictEqual(before.length, 1);
        assert.strictEqual(before[0].state, vscode.CommentThreadState.Unresolved);
        const identity = before[0];

        // Simulate the agent resolving and adding a reply.
        fs.writeFileSync(sidecarPath, item('r-1', 'resolved',
            '<comment author="You">do it</comment>\n<comment author="Agent">done</comment>'), 'utf8');
        controller.renderFromSidecar(sidecarPath);

        const after = controller.threadsFor(sidecarPath);
        assert.strictEqual(after.length, 1, 'no duplicate thread created');
        assert.strictEqual(after[0], identity, 'same thread instance reused by id');
        assert.strictEqual(after[0].state, vscode.CommentThreadState.Resolved);
        assert.strictEqual(after[0].comments.length, 2, 'agent reply is now shown');
        assert.strictEqual(after[0].comments[1].author.name, 'Agent');
        controller.dispose();
    });

    test('removing an item from the sidecar disposes its thread', () => {
        fs.writeFileSync(sidecarPath, item('r-1', 'pending', '<comment author="You">a</comment>'), 'utf8');
        const controller = new ArtifactCommentController();
        controller.renderFromSidecar(sidecarPath);
        assert.strictEqual(controller.threadsFor(sidecarPath).length, 1);

        fs.writeFileSync(sidecarPath, '# Pending Review Comments for `recon.md`\n', 'utf8');
        controller.renderFromSidecar(sidecarPath);
        assert.strictEqual(controller.threadsFor(sidecarPath).length, 0, 'thread disposed when item removed');
        controller.dispose();
    });
});
