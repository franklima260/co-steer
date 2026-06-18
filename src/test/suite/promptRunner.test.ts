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

    test('runAsPrompt: spawns a real Node process and pipes stdin successfully', async () => {
        const piped = await runAsPrompt({
            filePath: planPath,
            agentCommand: process.execPath,
            agentArgs: ['-e', 'process.stdin.on("data", d => process.stdout.write(d));'],
            prefix: 'Prefix:'
        });

        assert.strictEqual(piped, true, 'should successfully spawn and pipe');
    });

    test('runAsPrompt: handles non-zero exit from spawned process', async () => {
        const piped = await runAsPrompt({
            filePath: planPath,
            agentCommand: process.execPath,
            agentArgs: ['-e', 'process.exit(42);'],
            prefix: 'Prefix:'
        });

        assert.strictEqual(piped, true, 'should successfully spawn even if exit code is non-zero');
    });

    test('runAsPrompt: handles failed spawn (non-existent command) without throwing', async () => {
        const piped = await runAsPrompt({
            filePath: planPath,
            agentCommand: 'some-completely-invalid-command-that-does-not-exist-xyz',
            agentArgs: [],
            prefix: 'Prefix:'
        });

        assert.strictEqual(typeof piped, 'boolean', 'should resolve to a boolean status');
    });
});
