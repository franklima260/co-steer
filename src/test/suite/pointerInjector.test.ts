import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getCommentSyntaxForLanguage, getCustomCommentSyntax, injectPointer, removePointer } from '../../utils/pointerInjector';

suite('Pointer Injector Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const testFilePath = path.join(testFixturesPath, 'pointerTest.js');
    const pythonFilePath = path.join(testFixturesPath, 'pointerTest.py');
    const shebangFilePath = path.join(testFixturesPath, 'pointerTest.sh');
    const unknownFilePath = path.join(testFixturesPath, 'pointerTest.unknown');

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(testFilePath, 'function main() {}', 'utf8');
        fs.writeFileSync(pythonFilePath, 'def main():\n    pass', 'utf8');
        fs.writeFileSync(shebangFilePath, '#!/bin/bash\necho "hello"', 'utf8');
        fs.writeFileSync(unknownFilePath, 'some content', 'utf8');
    });

    teardown(async () => {
        // Clean up files
        const files = [testFilePath, pythonFilePath, shebangFilePath, unknownFilePath];
        for (const file of files) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
            const sidecar = `${file}.review.md`;
            if (fs.existsSync(sidecar)) {
                fs.unlinkSync(sidecar);
            }
        }

        // Reset config setting
        const config = vscode.workspace.getConfiguration('co-steer');
        await config.update('customCommentSyntaxes', undefined, vscode.ConfigurationTarget.Global);
    });

    test('getCommentSyntaxForLanguage returns correct defaults for common languages', () => {
        const jsSyntax = getCommentSyntaxForLanguage('javascript');
        assert.ok(jsSyntax);
        assert.strictEqual(jsSyntax.lineComment, '//');

        const pySyntax = getCommentSyntaxForLanguage('python');
        assert.ok(pySyntax);
        assert.strictEqual(pySyntax.lineComment, '#');

        const htmlSyntax = getCommentSyntaxForLanguage('html');
        assert.ok(htmlSyntax);
        assert.deepStrictEqual(htmlSyntax.blockComment, ['<!--', '-->']);
    });

    test('getCustomCommentSyntax reads configuration override by languageId and file extension', async () => {
        const config = vscode.workspace.getConfiguration('co-steer');
        await config.update('customCommentSyntaxes', {
            'custom-lang': '###',
            '.custom-ext': '//custom'
        }, vscode.ConfigurationTarget.Global);

        const langSyntax = getCustomCommentSyntax('custom-lang', '');
        assert.ok(langSyntax);
        assert.strictEqual(langSyntax.lineComment, '###');

        const extSyntax = getCustomCommentSyntax('other-lang', '.custom-ext');
        assert.ok(extSyntax);
        assert.strictEqual(extSyntax.lineComment, '//custom');
    });

    test('injectPointer inserts line comment at the top for JS/Python', async () => {
        await injectPointer(testFilePath, 'javascript');
        const content = fs.readFileSync(testFilePath, 'utf8');
        assert.ok(content.startsWith('// [Co-Steer] pending review:'));
        assert.ok(content.includes('function main() {}'));

        await injectPointer(pythonFilePath, 'python');
        const pyContent = fs.readFileSync(pythonFilePath, 'utf8');
        assert.ok(pyContent.startsWith('# [Co-Steer] pending review:'));
        assert.ok(pyContent.includes('def main():'));
    });

    test('injectPointer inserts pointer after shebang line', async () => {
        await injectPointer(shebangFilePath, 'shellscript');
        const content = fs.readFileSync(shebangFilePath, 'utf8');
        const lines = content.split(/\r?\n/);
        assert.strictEqual(lines[0], '#!/bin/bash');
        assert.ok(lines[1].startsWith('# [Co-Steer] pending review:'));
        assert.strictEqual(lines[2], 'echo "hello"');
    });

    test('injectPointer updates pointer line if relative path changes', async () => {
        // Seed with a different pointer line
        const oldPointer = '// [Co-Steer] pending review: old/path/file.review.md';
        fs.writeFileSync(testFilePath, `${oldPointer}\nfunction main() {}`, 'utf8');

        await injectPointer(testFilePath, 'javascript');
        const content = fs.readFileSync(testFilePath, 'utf8');
        assert.ok(!content.includes('old/path'));
        assert.ok(content.includes('[Co-Steer] pending review:'));
        assert.ok(content.includes('function main() {}'));
    });

    test('injectPointer throws error for unknown comment syntax and does not modify file', async () => {
        await assert.rejects(
            async () => {
                await injectPointer(unknownFilePath, 'unknown-lang');
            },
            /Unknown comment syntax for languageId "unknown-lang"/
        );

        const content = fs.readFileSync(unknownFilePath, 'utf8');
        assert.strictEqual(content, 'some content');
    });

    test('removePointer removes injected pointer line and leaves rest of file intact', async () => {
        await injectPointer(testFilePath, 'javascript');
        const injectedContent = fs.readFileSync(testFilePath, 'utf8');
        assert.ok(injectedContent.includes('[Co-Steer] pending review:'));

        await removePointer(testFilePath);
        const removedContent = fs.readFileSync(testFilePath, 'utf8');
        assert.strictEqual(removedContent, 'function main() {}');
    });

    test('removePointer leaves file unchanged if no pointer is present', async () => {
        const before = fs.readFileSync(testFilePath, 'utf8');
        await removePointer(testFilePath);
        const after = fs.readFileSync(testFilePath, 'utf8');
        assert.strictEqual(after, before);
    });
});
