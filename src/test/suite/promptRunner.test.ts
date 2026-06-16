import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runAsPrompt } from '../../agent/promptRunner';

suite('runAsPrompt Test Suite', () => {
    const testFixturesPath = path.resolve(__dirname, '../../../test-fixtures');
    const planPath = path.join(testFixturesPath, 'plan.md');

    setup(() => {
        if (!fs.existsSync(testFixturesPath)) {
            fs.mkdirSync(testFixturesPath, { recursive: true });
        }
        fs.writeFileSync(planPath, '# Plan\nStep one.', 'utf8');
    });

    teardown(() => {
        if (fs.existsSync(planPath)) {
            fs.unlinkSync(planPath);
        }
    });

    test('with no agent, copies prefixed prompt to clipboard and returns false', async () => {
        const piped = await runAsPrompt({
            filePath: planPath,
            agentCommand: undefined,
            prefix: 'Execute the following approved plan:'
        });

        assert.strictEqual(piped, false, 'nothing was piped to an agent');
        const clip = await vscode.env.clipboard.readText();
        assert.ok(clip.startsWith('Execute the following approved plan:'), 'prefix is present');
        assert.ok(clip.includes('# Plan'), 'artifact body is present');
        assert.ok(clip.includes('Step one.'), 'full artifact body is present');
    });

    test('returns false and surfaces error when the artifact cannot be read', async () => {
        const piped = await runAsPrompt({
            filePath: path.join(testFixturesPath, 'does-not-exist.md'),
            agentCommand: undefined,
            prefix: 'prefix'
        });
        assert.strictEqual(piped, false);
    });
});
