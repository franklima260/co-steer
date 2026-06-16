import * as assert from 'assert';
import { buildAgentSpawn } from '../../agent/spawn';

suite('buildAgentSpawn Test Suite', () => {
    const isWin = process.platform === 'win32';

    test('quotes every token and uses a shell on Windows', function () {
        if (!isWin) {
            this.skip();
        }
        const inv = buildAgentSpawn('claude.cmd', ['--flag', 'C:\\path with space\\plan.md']);
        assert.strictEqual(inv.options.shell, true);
        assert.deepStrictEqual(inv.args, []);
        // The whole invocation is one pre-quoted string so metacharacters in the path
        // (e.g. spaces) cannot break the command.
        assert.strictEqual(inv.command, '"claude.cmd" "--flag" "C:\\path with space\\plan.md"');
    });

    test('a path with shell metacharacters stays inside quotes on Windows', function () {
        if (!isWin) {
            this.skip();
        }
        const inv = buildAgentSpawn('agent', ['C:\\repo\\evil & calc.md']);
        assert.strictEqual(inv.command, '"agent" "C:\\repo\\evil & calc.md"');
    });

    test('uses no shell and passes args verbatim on POSIX', function () {
        if (isWin) {
            this.skip();
        }
        const inv = buildAgentSpawn('claude', ['--flag', '/tmp/plan.md']);
        assert.strictEqual(inv.options.shell, false);
        assert.strictEqual(inv.command, 'claude');
        assert.deepStrictEqual(inv.args, ['--flag', '/tmp/plan.md']);
    });
});
