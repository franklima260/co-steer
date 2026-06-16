# Co-Steer Testing Standards

**Audience:** every engineer and AI agent working on this codebase.

This document is binding, not aspirational. Code that ships without satisfying these standards is not done.

---

## 1. The non-negotiable rules

1. **Every code path must be covered by a test that fails when the code path breaks.** "It compiles" is not coverage. "It runs without crashing" is not coverage.
2. **A test name must describe the invariant it protects, not the function it calls.** `TestSidecarParse_MalformedXML_ThrowsError` — yes. `TestParse` — no.
3. **A test must fail if the production code's behavior changes, and pass otherwise.** If you can delete the assertion and the test still "passes," the assertion is bad.
4. **No mocking of VS Code APIs where possible.** Use the `@vscode/test-electron` test harness to run tests in a real VS Code environment with a real workspace.
5. **Tests must be deterministic.** No `setTimeout` hoping for VS Code to update, no real wall clocks, no network calls to external LLM providers.
6. **A new feature is not merged without tests.** A bug fix is not merged without a regression test that fails before the fix and passes after.

---

## 2. What "tested" actually means

A function is tested if **every meaningful branch, error path, and boundary condition has a dedicated assertion**. Specifically:

### 2.1 Required coverage per function

For any non-trivial function, the test file must include all of:

- **Happy path** with realistic input.
- **Each conditional branch** taken at least once.
- **Each error return / thrown exception** triggered at least once.
- **Every boundary** (empty input, malformed XML, unresolvable paths).

### 2.2 Required coverage per extension command

Every command registered in `package.json` must have a test that:
- Executes the command via `vscode.commands.executeCommand`.
- Asserts the expected side effects (e.g., file created on disk, tree view updated, virtual document scheme resolves).

---

## 3. Forbidden test anti-patterns

Reviewers will reject any PR containing these. AI agents must refuse to write them.

### 3.1 Vacuous loops

```typescript
for (const comment of result.comments) {
    if (comment.author !== "You") { assert.fail("...") }
}
```

If `result.comments` is empty (the exact bug you're testing for), the loop runs zero times and the test passes. **Always assert the collection size before iterating.**

```typescript
assert.strictEqual(result.comments.length, 1);
if (result.comments[0].author !== "You") { ... }
```

### 3.2 Defensive `if` guards in tests

```typescript
const calledWith = mockAgent.calls[0]?.[0];
if (calledWith !== null) {
    assert.strictEqual(calledWith.includes('target'), true);
}
```

The `if` makes the test silently skip its core assertion when the mock was called with `null`. **Tests assert; they do not branch.** Compute the expected value and use a single, unconditional assertion.

### 3.3 Tautological assertions

```typescript
assert.deepStrictEqual(result, result);
```

Or its more subtle cousin:

```typescript
const expected = computeExpectation(input);  // calls the same code the test exercises
assert.deepStrictEqual(actualOutput, expected);
```

The expected value must be hard-coded or derived independently — never produced by re-running the code under test.

### 3.4 Tests with non-deterministic timing

`setTimeout`, `setInterval`, sleep statements — all banned in test bodies. If you need to wait for a VS Code event (like `onDidSaveTextDocument`), use a Promise that resolves when the event fires, rather than `await new Promise(r => setTimeout(r, 100))`.

---

## 4. Extension (TypeScript) standards

### 4.1 Test layout

- Tests live in `src/test/suite/`.
- One test file per major feature or provider (e.g., `commentController.test.ts`, `treeProvider.test.ts`).
- Use Mocha's `suite` and `test` functions.

### 4.2 The VS Code Harness

Every integration test **must** run through the `@vscode/test-electron` runner.
Use a dedicated `test-fixtures` directory as the workspace folder for the tests so that file system operations do not corrupt the actual project directory.

```typescript
import * as vscode from 'vscode';
import * as path from 'path';

suite('ReviewDocumentProvider', () => {
    test('Provides content for ai-review scheme', async () => {
        const uri = vscode.Uri.parse('ai-review:///mock/path/file.txt');
        const doc = await vscode.workspace.openTextDocument(uri);
        assert.ok(doc.getText().includes('expected content'));
    });
});
```

### 4.3 Clean up after yourself

If a test creates a `.review.md` sidecar file, it must delete it in the `teardown` or `afterEach` hook to ensure subsequent tests have a clean environment.
