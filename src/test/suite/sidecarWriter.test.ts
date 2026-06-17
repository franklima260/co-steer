import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { addNewComment, addReply, setStatus, sidecarPathFor } from '../../utils/sidecarWriter';
import { parseReviewItems } from '../../utils/sidecar';

suite('Sidecar writer Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const originalPath = path.join(testFixturesPath, 'writer.md');
    const sidecarPath = sidecarPathFor(originalPath);

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(originalPath, 'line one\nline two\nline three', 'utf8');
    });

    teardown(() => {
        for (const p of [originalPath, sidecarPath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    });

    test('addNewComment captures the source line range as target code', async () => {
        const id = await addNewComment({
            originalFilePath: originalPath,
            startLine: 1,
            endLine: 2,
            text: 'tighten this',
            author: 'You'
        });
        const items = parseReviewItems(fs.readFileSync(sidecarPath, 'utf8'));
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].id, id);
        assert.strictEqual(items[0].status, 'pending');
        assert.strictEqual(items[0].targetCode, 'line one\nline two', 'target code is the exact source slice');
        assert.deepStrictEqual(items[0].comments, [{ author: 'You', text: 'tighten this' }]);
    });

    test('addReply appends a comment to the matching item', async () => {
        const id = await addNewComment({ originalFilePath: originalPath, startLine: 1, endLine: 1, text: 'q', author: 'You' });
        const ok = await addReply(originalPath, id, 'answer', 'Agent');
        assert.strictEqual(ok, true);
        const item = parseReviewItems(fs.readFileSync(sidecarPath, 'utf8'))[0];
        assert.strictEqual(item.comments.length, 2);
        assert.deepStrictEqual(item.comments[1], { author: 'Agent', text: 'answer' });
    });

    test('addReply returns false for an unknown id', async () => {
        await addNewComment({ originalFilePath: originalPath, startLine: 1, endLine: 1, text: 'q', author: 'You' });
        assert.strictEqual(await addReply(originalPath, 'nope', 'x', 'You'), false);
    });

    test('setStatus flips an item to resolved', async () => {
        const id = await addNewComment({ originalFilePath: originalPath, startLine: 1, endLine: 1, text: 'q', author: 'You' });
        assert.strictEqual(await setStatus(originalPath, id, 'resolved'), true);
        const item = parseReviewItems(fs.readFileSync(sidecarPath, 'utf8'))[0];
        assert.strictEqual(item.status, 'resolved');
    });
});
