import * as assert from 'assert';
import { logger } from '../../utils/logger';

suite('Telemetry Logger Test Suite', () => {
    setup(() => {
        logger.clearLogs();
    });

    teardown(() => {
        logger.clearLogs();
    });

    test('logger.info outputs basic message correctly', () => {
        logger.info('hello');
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=INFO msg=hello');
    });

    test('logger.info quotes message with space or special characters', () => {
        logger.info('hello world');
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=INFO msg="hello world"');
    });

    test('logger.warn format handles context properties', () => {
        logger.warn('warning message', { file: 'foo.txt', count: 123 });
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=WARN msg="warning message" file=foo.txt count=123');
    });

    test('logger.error format handles errors in context', () => {
        const err = new Error('database connection failed');
        logger.error('failed operation', { error: err });
        assert.strictEqual(logger.loggedLines.length, 1);
        const logLine = logger.loggedLines[0];
        assert.ok(logLine.startsWith('level=ERROR msg="failed operation" error="Error: database connection failed'));
    });

    test('logger.debug handles complex context structure', () => {
        logger.debug('debug info', { nested: { a: 1, b: 'two' } });
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=DEBUG msg="debug info" nested="{\\"a\\":1,\\"b\\":\\"two\\"}"');
    });

    test('logger.counter formats metric.counter correctly', () => {
        logger.counter('costeer.agent.invocation', { outcome: 'success' });
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=INFO msg=metric.counter name=costeer.agent.invocation delta=1 outcome=success');
    });

    test('logger.histogram formats metric.histogram correctly', () => {
        logger.histogram('costeer.parse.duration_ms', 42, { file: 'foo.txt' });
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=INFO msg=metric.histogram name=costeer.parse.duration_ms value=42 file=foo.txt');
    });

    test('logger.clearLogs empties in-memory buffer', () => {
        logger.info('one');
        logger.info('two');
        assert.strictEqual(logger.loggedLines.length, 2);
        logger.clearLogs();
        assert.strictEqual(logger.loggedLines.length, 0);
    });

    test('logger handles null/undefined values in context', () => {
        logger.info('test', { emptyVal: null, undefVal: undefined });
        assert.strictEqual(logger.loggedLines.length, 1);
        assert.strictEqual(logger.loggedLines[0], 'level=INFO msg=test emptyVal=null undefVal=null');
    });
});
