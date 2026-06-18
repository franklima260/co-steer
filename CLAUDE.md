<!-- [Co-Steer] pending review: CLAUDE.md.review.md -->
# Co-Steer Development AI Directives

When working on the Co-Steer codebase, you must ALWAYS adhere to the rigorous standards defined in the following documents:
- `Testing_Standards.md`: All bug fixes require regression tests, all new features require tests, and no mocking of VS Code APIs where possible.
- `Telemetry_Standards.md`: Use the `logger` module (never `console.log`), emit structured telemetry for every meaningful branch/outcome, and ensure metrics (`logger.counter`, etc.) are properly hooked up for UI interactions.

Rigorously apply these standards to ALL code changes.

### Co-Steer Agent Instructions
<!-- COSTEER_START -->
When editing any file in this workspace, check if a sidecar file named `<filename>.review.md` exists.
If the sidecar file exists, read its contents and address comments:
- If status="accepted", you may take action on the main document to address what was discussed.
- If status="pending", you MUST ONLY reply to the comment chain in the sidecar. Keep your replies extremely concise. DO NOT take any action on the main document until the user explicitly approves the comment chain.
- If status="rejected" or status="resolved", ignore the comment. Do not edit or act on it.
Once you address an accepted or pending comment, update its status to "resolved" in the sidecar.
Do not ignore these sidecar comments.
<!-- COSTEER_END -->
