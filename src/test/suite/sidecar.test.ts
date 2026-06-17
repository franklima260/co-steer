import * as assert from 'assert';
import { countReviewItems, parseReviewItems, serializeReviewItem, buildSidecarContent } from '../../utils/sidecar';

suite('Sidecar parser Test Suite', () => {
    test('parses id, status, location and multiple authored comments', () => {
        const content = `# header
<review_item id="r-abc" status="resolved">
<location>
File: \`plan.md\`
Lines: 4-6
</location>

<target_code>
\`\`\`md
hello
\`\`\`
</target_code>

<comment author="You">
Tighten this.
</comment>

<comment author="Agent">
Done.
</comment>
</review_item>`;
        const items = parseReviewItems(content);
        assert.strictEqual(items.length, 1);
        const item = items[0];
        assert.strictEqual(item.id, 'r-abc');
        assert.strictEqual(item.status, 'resolved');
        assert.strictEqual(item.file, 'plan.md');
        assert.strictEqual(item.startLine, 4);
        assert.strictEqual(item.endLine, 6);
        assert.strictEqual(item.targetCode, 'hello');
        assert.strictEqual(item.comments.length, 2);
        assert.deepStrictEqual(item.comments[0], { author: 'You', text: 'Tighten this.' });
        assert.deepStrictEqual(item.comments[1], { author: 'Agent', text: 'Done.' });
    });

    test('synthesizes a stable id when an agent omits one', () => {
        const block = '<review_item status="pending">\n<comment author="Agent">Q?</comment>\n</review_item>';
        const a = parseReviewItems(block)[0].id;
        const b = parseReviewItems(block)[0].id;
        assert.ok(a.startsWith('auto-'), 'synthesized ids are prefixed');
        assert.strictEqual(a, b, 'same content yields the same synthesized id');
    });

    test('back-compat: legacy <user_feedback> is read as one You comment', () => {
        const content = '<review_item id="r-1" status="pending">\n<user_feedback>\nold style\n</user_feedback>\n</review_item>';
        const item = parseReviewItems(content)[0];
        assert.strictEqual(item.comments.length, 1);
        assert.deepStrictEqual(item.comments[0], { author: 'You', text: 'old style' });
    });

    test('serialize -> parse round-trips the meaningful fields', () => {
        const original = {
            id: 'r-xyz',
            status: 'pending' as const,
            file: 'a.ts',
            startLine: 2,
            endLine: 5,
            language: 'ts',
            targetCode: 'const x = 1;',
            comments: [{ author: 'You', text: 'rename x' }]
        };
        const parsed = parseReviewItems(serializeReviewItem(original))[0];
        assert.deepStrictEqual(parsed, original);
    });

    test('counts pending and resolved review items independently', () => {
        const content = [
            '<review_item status="pending">',
            '</review_item>',
            '<review_item status="resolved">',
            '</review_item>',
            '<review_item status="pending">',
            '</review_item>'
        ].join('\n');
        const counts = countReviewItems(content);
        assert.strictEqual(counts.pending, 2);
        assert.strictEqual(counts.resolved, 1);
    });

    test('treats unknown status values as pending', () => {
        const counts = countReviewItems('<review_item status="in_progress"></review_item>');
        assert.strictEqual(counts.pending, 1);
        assert.strictEqual(counts.resolved, 0);
    });

    test('returns zero counts for content with no review items', () => {
        const counts = countReviewItems('# Pending Review Comments for `foo.js`');
        assert.strictEqual(counts.pending, 0);
        assert.strictEqual(counts.resolved, 0);
    });

    test('buildSidecarContent separates pending and resolved items', () => {
        const pendingItem = {
            id: 'r-1',
            status: 'pending' as const,
            file: 'a.ts',
            comments: [{ author: 'You', text: 'fix this' }]
        };
        const resolvedItem = {
            id: 'r-2',
            status: 'resolved' as const,
            file: 'b.ts',
            comments: [{ author: 'You', text: 'fixed' }]
        };
        
        const content = buildSidecarContent('test.md', [pendingItem, resolvedItem]);
        
        assert.ok(content.includes('# Review Comments for `test.md`'));
        assert.ok(content.includes('<review_item id="r-1" status="pending">'));
        assert.ok(content.includes('<!-- COSTEER_RESOLVED_START'));
        assert.ok(content.includes('<review_item id="r-2" status="resolved">'));
        assert.ok(content.includes('COSTEER_RESOLVED_END -->'));
        
        const pendingIdx = content.indexOf('<review_item id="r-1" status="pending">');
        const resolvedStartIdx = content.indexOf('<!-- COSTEER_RESOLVED_START');
        assert.ok(pendingIdx < resolvedStartIdx);
    });
});
