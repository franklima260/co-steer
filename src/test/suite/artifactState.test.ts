import * as assert from 'assert';
import { ArtifactStateStore } from '../../state/ArtifactStateStore';

suite('ArtifactStateStore Test Suite', () => {
    test('get returns the most recently set state', () => {
        const store = new ArtifactStateStore();
        assert.strictEqual(store.get('/a/b.md'), undefined);
        store.set('/a/b.md', 'iterating');
        assert.strictEqual(store.get('/a/b.md'), 'iterating');
        store.set('/a/b.md', 'resolved');
        assert.strictEqual(store.get('/a/b.md'), 'resolved');
        store.dispose();
    });

    test('fires onDidChange only on actual transitions', () => {
        const store = new ArtifactStateStore();
        let fires = 0;
        store.onDidChange(() => fires++);

        store.set('/x.md', 'iterating');
        store.set('/x.md', 'iterating'); // no-op, same state
        assert.strictEqual(fires, 1, 'duplicate set must not fire');

        store.set('/x.md', 'pending');
        assert.strictEqual(fires, 2);
        store.dispose();
    });

    test('clear removes state and fires once', () => {
        const store = new ArtifactStateStore();
        let fires = 0;
        store.set('/y.md', 'iterating');
        store.onDidChange(() => fires++);
        store.clear('/y.md');
        assert.strictEqual(store.get('/y.md'), undefined);
        assert.strictEqual(fires, 1);
        store.clear('/y.md'); // already gone, no fire
        assert.strictEqual(fires, 1);
        store.dispose();
    });
});
