import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownReviewPanel, SCRIPT } from '../../panels/MarkdownReviewPanel';

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

    test('SCRIPT contains robust window click delegation and telemetry for comments', () => {
        // Verify event delegation is correctly placed on the window to allow clicking off highlights
        assert.ok(SCRIPT.includes("window.addEventListener('click'"), "Should use window.addEventListener for robust dismissal");
        assert.ok(!SCRIPT.includes("content.addEventListener('click'"), "Should not attach click listener to content directly");
        
        // Verify telemetry
        assert.ok(SCRIPT.includes("name: 'webview.comment.activate'"), "Should emit telemetry for comment activation");
        assert.ok(SCRIPT.includes("name: 'webview.comment.dismiss'"), "Should emit telemetry for comment dismissal");

        // Verify toggling logic for comment highlights and cards to allow dismissing resolved highlights
        assert.ok(SCRIPT.includes("activeCommentId === commentId"), "Should toggle highlight active state off if already active");
        assert.ok(SCRIPT.includes("activeCommentId === item.id"), "Should toggle card active state off if already active");
    });

    test('Webview real browser DOM integration test without mocks', async () => {
        // 1. Write the target markdown document explicitly
        const markdownContent = `# Implementation Plan\nThis is a test document.\nWe will write comments here.\n`;
        fs.writeFileSync(mdPath, markdownContent, 'utf8');

        // 2. Create a sidecar file with a pending comment
        const sidecarPath = `${mdPath}.review.md`;
        const sidecarContent = `<review_item id="r-test-1" status="pending">
<location>
File: panelTest.md
Lines: 2-3
</location>
<target_code>
\`\`\`md
This is a test document.
\`\`\`
</target_code>
<comment author="You">
Needs clarification
</comment>
</review_item>`;
        fs.writeFileSync(sidecarPath, sidecarContent, 'utf8');

        // 3. Show the review panel
        MarkdownReviewPanel.show(mdPath);
        const panel = MarkdownReviewPanel.getPanel(mdPath);
        assert.ok(panel, 'Panel should be created');

        // 4. Wait for the webview to become ready
        let readyResolver: () => void;
        const readyPromise = new Promise<void>((resolve) => {
            readyResolver = resolve;
        });

        // 5. Set up message listening for test results
        let testResultResolver: (value: any) => void;
        const testResultPromise = new Promise<any>((resolve) => {
            testResultResolver = resolve;
        });

        const disposable = panel.getWebviewPanel().webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'ready') {
                readyResolver();
            } else if (msg.type === 'testResult') {
                testResultResolver(msg);
            }
        });

        try {
            // Wait for the ready event
            await readyPromise;

            // 6. Trigger the DOM tests inside the actual Chromium instance
            panel.getWebviewPanel().webview.postMessage({ type: 'runTest' });

            // 7. Wait for the test results back from Chromium
            const result = await testResultPromise;
            assert.strictEqual(result.success, true, `Webview DOM tests failed: ${result.error}`);
        } finally {
            disposable.dispose();
            MarkdownReviewPanel.disposeAll();
        }
    });
});
