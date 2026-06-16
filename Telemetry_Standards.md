# Telemetry Standards

This document is the source of truth for **what to log, when, how, and why**
in Co-Steer. It is written primarily for AI coding agents — the assumption
that will frame every decision below — but applies equally to human
contributors.

---

## 0. Audience: agent-first

Most documentation in this repo describes what the system does. This
document describes how the system explains itself to people (and agents)
who weren't there when it broke.

An AI coding agent working on Co-Steer has profoundly different tools from a
developer at a debugger:

| Human at a debugger | Agent on a transcript |
|---|---|
| Sets a breakpoint, inspects locals | Reads a log line |
| Steps through code | Greps for a string |
| Re-runs with print statements | Cannot easily re-trigger VS Code UI events |
| Asks a teammate | Asks the user, costing time and trust |
| Builds intuition over months | Has a fresh context per session |

Every minute of an agent's session is also a minute of the user's time and
a slice of the context window. **The cheapest debugging is the debugging
that doesn't have to happen** — a log line that says exactly what went
wrong, with enough structured context, takes the agent straight to the
fix.

This document's goal is to make Co-Steer's telemetry agent-debuggable
**without a re-run**. Every extension failure should leave behind enough
structured evidence in the VS Code Output Channel to identify the cause from logs alone.

---

## 1. Why rigorous telemetry matters

### 1.1 The Sidecar Parsing investigation: a case study

Before any of this observability work, a user might report:

> `Iterate failed: unexpected end of JSON input when parsing sidecar`

The investigation takes **multiple sessions and context cycles**. The chain of reasoning required:
1. Is the file actually empty, or did the watcher fire too early?
2. Did the agent write malformed XML in the `.review.md`?
3. How often does this happen?

With rigorous telemetry, the report is self-diagnosing:

```
level=INFO msg=metric.counter name=costeer.agent.invocation delta=1
level=DEBUG msg="costeer: watcher fired" file=example.js.review.md size=0
level=WARN msg="costeer: empty sidecar detected, waiting for flush" retries=1
level=INFO msg=metric.histogram name=costeer.parse.duration_ms value=12
level=ERROR msg="costeer: invalid XML in sidecar" file=example.js.review.md error="missing closing tag"
```

From those lines, an agent can establish: the watcher fired on an empty file, we retried, parsing took 12ms, but the XML was missing a closing tag. That's a 30-second diagnosis instead of a multi-session investigation.

---

## 2. Standards: the always-do list

These are not suggestions. Code that violates them should be rejected at review.

### 2.1 Use the `logger` module; never `console.log`

```typescript
// WRONG
console.log(`parsing complete: ${count} items`);
console.error("agent failed");

// RIGHT
logger.info("parsing complete", { items: count });
logger.error("agent failed", { error: err.message });
```

The `logger` module is the single chokepoint where level filtering and output channel routing hook in. Calls outside it bypass the VS Code Output panel and won't appear in user-submitted bug reports.

### 2.2 Use the right helper for the right shape

| Shape | Helper | Example |
|---|---|---|
| State transition / event | `logger.info` | `"iteration started"`, `"sidecar created"` |
| Recoverable problem | `logger.warn` | `"empty sidecar, retrying"` |
| Unrecoverable problem | `logger.error` | `"failed to launch agent CLI"` |
| Step-by-step trace | `logger.debug` | `"parsing XML block"` |
| Counted event | `logger.counter` | `"agent.invocation{outcome=success}"` |
| Latency distribution | `logger.histogram` | `"diff.render_ms"` |

### 2.3 Use structured key/value, never string interpolation

```typescript
// WRONG — agent has to parse the message; values are unsearchable
logger.info(`processed ${n} files in ${ms}ms for document ${doc}`);

// RIGHT — every field is grep-able as key=value in the log output
logger.info("review: document processed", { files: n, duration_ms: ms, document: doc });
```

The agent's primary tool is `grep`/`Grep`. Free-form interpolation is structurally hostile to the agent's primary tool.

### 2.4 Bucket outcomes; do not log only the happy path

Every meaningful branch should produce a counter or log on **every**
exit, not just the success exit. 

```typescript
// WRONG — only one outcome is observable
try {
    await agent.iterate(file);
} catch (err) {
    logger.error("agent failed", { error: err });
    throw err;
}

// RIGHT — every outcome is bucketed
try {
    await agent.iterate(file);
    logger.counter("agent.iterate", { outcome: "success" });
} catch (err) {
    logger.counter("agent.iterate", { outcome: "error" });
    logger.error("agent failed", { error: err });
    throw err;
}
```

### 2.5 Log the "Why", not just the "What"

When returning or throwing an error, the log must include the context that caused it.
If the agent CLI fails, log the command that was run, the exit code, and the stderr output.
