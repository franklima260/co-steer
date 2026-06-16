import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactCommentController } from '../../controllers/CommentController';

suite('ArtifactCommentController Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const testFilePath = path.join(testFixturesPath, 'commentTest.js');
    const sidecarPath = `${testFilePath}.review.md`;

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(testFilePath, 'function test() {\n  return true;\n}', 'utf8');
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
    });

    teardown(() => {
        if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
    });

    test('addComment writes correct XML to sidecar', async () => {
        const controller = new ArtifactCommentController();
        
        // Mock reply
        const mockUri = vscode.Uri.file(testFilePath);
        const mockReply: any = {
            text: 'Please use an arrow function',
            thread: {
                uri: mockUri,
                range: new vscode.Range(0, 0, 2, 0),
                comments: [],
                dispose: () => {}
            }
        };

        await controller.addComment(mockReply);

        assert.ok(fs.existsSync(sidecarPath), 'Sidecar file should be created');
        const content = fs.readFileSync(sidecarPath, 'utf8');

        assert.ok(/<review_item id="r-[0-9a-f]+" status="pending">/.test(content), 'Contains review item with a stable id');
        assert.ok(content.includes('<comment author="You">'), 'Comment is attributed to the user');
        assert.ok(content.includes('Please use an arrow function'), 'Contains user feedback');
        assert.ok(content.includes('function test()'), 'Contains target code');

        controller.dispose();
    });

    test('addComment with no range does not write a sidecar', async () => {
        const controller = new ArtifactCommentController();
        const mockReply: any = {
            text: 'feedback without a range',
            thread: {
                uri: vscode.Uri.file(testFilePath),
                range: undefined,
                comments: [],
                dispose: () => {}
            }
        };

        await controller.addComment(mockReply);

        assert.strictEqual(fs.existsSync(sidecarPath), false,
            'No sidecar should be created when the thread has no range');
        controller.dispose();
    });
});
