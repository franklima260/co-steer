import * as assert from 'assert';
import { renderMarkdownToHtml } from '../../utils/markdown';

suite('Markdown renderer Test Suite', () => {
    test('renders headings and paragraphs to HTML', () => {
        const html = renderMarkdownToHtml('# Title\n\nHello world');
        assert.ok(/<h1[^>]*>Title<\/h1>/.test(html), 'heading rendered');
        assert.ok(/<p[^>]*>Hello world<\/p>/.test(html), 'paragraph rendered');
    });

    test('annotates block elements with source line anchors', () => {
        const html = renderMarkdownToHtml('# Title\n\nsecond paragraph');
        // The heading starts on line 0; the paragraph starts on line 2 (0-based).
        assert.ok(/<h1 data-line="0" data-line-end="1"/.test(html), 'heading carries its line range');
        assert.ok(/data-line="2"/.test(html), 'later block carries a later line anchor');
    });

    test('does not pass through raw HTML/script from the source', () => {
        const html = renderMarkdownToHtml('<script>alert(1)</script>\n\nok');
        assert.ok(!html.includes('<script>'), 'raw HTML is escaped, not emitted');
    });
});
