import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewDocumentProvider } from '../../providers/ReviewDocumentProvider';

suite('ReviewDocumentProvider Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const testFilePath = path.join(testFixturesPath, 'doc.js');

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(testFilePath, 'console.log("hello");', 'utf8');
    });

    teardown(() => {
        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }
    });

    test('provideTextDocumentContent returns physical file content', async () => {
        const provider = new ReviewDocumentProvider();
        const uri = vscode.Uri.file(testFilePath).with({ scheme: ReviewDocumentProvider.scheme });
        
        const content = await provider.provideTextDocumentContent(uri);
        assert.strictEqual(content, 'console.log("hello");');
    });
    
    test('provideTextDocumentContent handles missing files', async () => {
        const provider = new ReviewDocumentProvider();
        const missingPath = path.join(testFixturesPath, 'missing.js');
        const uri = vscode.Uri.file(missingPath).with({ scheme: ReviewDocumentProvider.scheme });
        
        const content = await provider.provideTextDocumentContent(uri);
        assert.ok(content.startsWith('File not found:'));
    });
});
