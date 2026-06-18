import * as assert from 'assert';
import { buildReviewPrompt } from '../../agent/reviewPrompt';

suite('buildReviewPrompt Test Suite', () => {
    test('references both the sidecar and the artifact, and the resolve instruction', () => {
        const prompt = buildReviewPrompt({ artifactPath: 'docs/Philosophy.md', sidecarPath: 'docs/Philosophy.md.review.md' });
        assert.ok(prompt.includes('docs/Philosophy.md.review.md'), 'mentions the sidecar to read');
        assert.ok(prompt.includes('docs/Philosophy.md'), 'mentions the artifact to edit');
        assert.ok(prompt.includes('accepted'), 'tells the agent to address accepted items');
        assert.ok(prompt.includes('resolved'), 'tells the agent to resolve addressed items');
    });
});
