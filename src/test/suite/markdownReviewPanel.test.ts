import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownReviewPanel } from '../../panels/MarkdownReviewPanel';

suite('MarkdownReviewPanel Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const mdPath = path.join(testFixturesPath, 'panelTest.md');

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(mdPath, '# Test\nContent', 'utf8');
    });

    teardown(() => {
        MarkdownReviewPanel.disposeAll();
        if (fs.existsSync(mdPath)) {
            fs.unlinkSync(mdPath);
        }
    });

    test('show creates panel and notifyChanged triggers refresh with different casing', () => {
        MarkdownReviewPanel.show(mdPath);

        // Path with different casing
        const lowerPath = mdPath.toLowerCase();
        const upperPath = mdPath.toUpperCase();

        // Execute notification with different casing to verify normalization key match
        MarkdownReviewPanel.notifyChanged(lowerPath);
        MarkdownReviewPanel.notifyChanged(upperPath);

        // Clean up
        MarkdownReviewPanel.disposeAll();
    });
});
