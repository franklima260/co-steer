/**
 * The canonical instruction handed to an agent so it knows to act on the sidecar rather
 * than the artifact alone. Used both by the "Copy Agent Prompt" command (paste into a chat
 * agent) and by Iterate (piped to a CLI agent over stdin). Mirrors the Agent Prompting
 * Standard in the design spec (§4).
 */
export function buildReviewPrompt(opts: { artifactPath: string; sidecarPath: string }): string {
    return [
        `Read \`${opts.sidecarPath}\`. It contains review feedback in <review_item> blocks.`,
        ``,
        `Do NOT process review items inside <!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END --> — they are already resolved and must be left unchanged.`,
        ``,
        `For each review comment, locate the section in \`${opts.artifactPath}\` using its <target_code> and apply the feedback:`,
        `- If status="accepted", you must address what was discussed in the comments.`,
        `- If status="pending", analyze and address the comment; if you are unsure about the action item, ask the user for clarification.`,
        `- If status="rejected" or status="resolved", ignore the comment and do not make changes for it.`,
        ``,
        `When a comment is addressed, set its status to "resolved" in the sidecar and preserve its id. You may append a <comment author="Agent"> noting what you changed. Leave other items unchanged.`
    ].join('\n');
}
