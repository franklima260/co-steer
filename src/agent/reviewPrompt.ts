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
        `For each pending block, use its <target_code> to locate the section in \`${opts.artifactPath}\`, apply the <comment> feedback, and rewrite \`${opts.artifactPath}\` with the complete revised content.`,
        ``,
        `When a review item is addressed, set its status to "resolved" in the sidecar and preserve its id. You may append a <comment author="Agent"> noting what you changed. Leave items you could not address as "pending".`
    ].join('\n');
}
