import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { generateWorkspaceRules } from '../../agent/workspaceRules';

suite('Workspace Rules Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const rulesDirPath = path.join(testFixturesPath, 'workspace-rules-test');

    setup(() => {
        if (!fs.existsSync(rulesDirPath)) {
            fs.mkdirSync(rulesDirPath, { recursive: true });
        }
    });

    teardown(() => {
        if (fs.existsSync(rulesDirPath)) {
            // Recursive deletion of test directory
            fs.rmSync(rulesDirPath, { recursive: true, force: true });
        }
    });

    test('generateWorkspaceRules creates all expected rule files', async () => {
        await generateWorkspaceRules(rulesDirPath);

        const expectedFiles = [
            '.cursorrules',
            '.github/copilot-instructions.md',
            'claude.json',
            '.clauderc',
            '.windsurfrules',
            '.antigravityrules',
            'CLAUDE.md'
        ];

        for (const file of expectedFiles) {
            const filePath = path.join(rulesDirPath, file);
            assert.ok(fs.existsSync(filePath), `Rule file ${file} should be generated`);

            const content = fs.readFileSync(filePath, 'utf8');
            if (file.endsWith('.json')) {
                // Must be valid JSON
                const parsed = JSON.parse(content);
                assert.ok(parsed.rules);
                assert.ok(Array.isArray(parsed.rules));
                assert.ok(parsed.rules[0].includes('Co-Steer'));
            } else {
                // Must contain Co-Steer instructions
                assert.ok(content.includes('Co-Steer Agent Instructions'));
                assert.ok(content.includes('<!-- COSTEER_START -->'));
            }
        }
    });

    test('generateWorkspaceRules appends to existing files without duplicating', async () => {
        // Create an existing text rule file
        const textPath = path.join(rulesDirPath, '.cursorrules');
        fs.writeFileSync(textPath, 'Existing Cursor rule\n', 'utf8');

        // Create an existing JSON rule file
        const jsonPath = path.join(rulesDirPath, 'claude.json');
        const initialJson = { rules: ['Initial rule'] };
        fs.writeFileSync(jsonPath, JSON.stringify(initialJson, null, 2), 'utf8');

        // Run rules generation
        await generateWorkspaceRules(rulesDirPath);

        // Verify text file appended
        const textContent = fs.readFileSync(textPath, 'utf8');
        assert.ok(textContent.startsWith('Existing Cursor rule'));
        assert.ok(textContent.includes('Co-Steer Agent Instructions'));

        // Verify JSON file parsed and appended
        const jsonContent = fs.readFileSync(jsonPath, 'utf8');
        const parsedJson = JSON.parse(jsonContent);
        assert.strictEqual(parsedJson.rules.length, 2);
        assert.strictEqual(parsedJson.rules[0], 'Initial rule');
        assert.ok(parsedJson.rules[1].includes('Co-Steer'));

        // Run generation again to ensure no duplicates are added
        await generateWorkspaceRules(rulesDirPath);

        const textContentSecond = fs.readFileSync(textPath, 'utf8');
        const matchesText = textContentSecond.match(/<!-- COSTEER_START -->/g);
        assert.strictEqual(matchesText?.length, 1, 'Markdown instructions should not be appended twice');

        const jsonContentSecond = fs.readFileSync(jsonPath, 'utf8');
        const parsedJsonSecond = JSON.parse(jsonContentSecond);
        assert.strictEqual(parsedJsonSecond.rules.length, 2, 'JSON rule should not be appended twice');
    });
});
