import * as fs from 'fs';
import * as crypto from 'crypto';

export interface SidecarStatusCounts {
    pending: number;
    resolved: number;
}

export type ReviewStatus = 'pending' | 'resolved';

export interface ReviewComment {
    author: string;
    text: string;
}

export interface ReviewItem {
    /** Stable identity used to match a block to its live gutter thread across edits. */
    id: string;
    status: ReviewStatus;
    file?: string;
    /** 1-based, inclusive line range as written in the sidecar. */
    startLine?: number;
    endLine?: number;
    language?: string;
    targetCode?: string;
    comments: ReviewComment[];
}

const ITEM_RE = /<review_item\b([^>]*)>([\s\S]*?)<\/review_item>/g;
const COMMENT_RE = /<comment\b([^>]*)>([\s\S]*?)<\/comment>/g;

function attr(attrs: string, name: string): string | undefined {
    const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return m ? m[1] : undefined;
}

/** Generate a fresh, collision-resistant id for a human-authored review item. */
export function generateReviewId(): string {
    return `r-${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Deterministic fallback id for blocks an agent added without one. Derived from content so
 * it stays stable across re-renders as long as the block's text doesn't change.
 */
function synthesizeId(body: string): string {
    return `auto-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}`;
}

/** Parse every `<review_item>` in a sidecar into structured form. */
export function parseReviewItems(content: string): ReviewItem[] {
    const items: ReviewItem[] = [];
    ITEM_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ITEM_RE.exec(content)) !== null) {
        const attrs = match[1];
        const body = match[2];

        const status: ReviewStatus = attr(attrs, 'status') === 'resolved' ? 'resolved' : 'pending';
        const id = attr(attrs, 'id') || synthesizeId(body);

        const fileMatch = /File:\s*`([^`]+)`/.exec(body);
        const linesMatch = /Lines:\s*(\d+)-(\d+)/.exec(body);
        const codeMatch = /<target_code>\s*```([^\n]*)\n([\s\S]*?)```/.exec(body);

        const comments: ReviewComment[] = [];
        COMMENT_RE.lastIndex = 0;
        let c: RegExpExecArray | null;
        while ((c = COMMENT_RE.exec(body)) !== null) {
            comments.push({ author: attr(c[1], 'author') || 'Unknown', text: c[2].trim() });
        }
        // Back-compat: a legacy <user_feedback> block counts as one comment from the user.
        if (comments.length === 0) {
            const fb = /<user_feedback>([\s\S]*?)<\/user_feedback>/.exec(body);
            if (fb && fb[1].trim()) {
                comments.push({ author: 'You', text: fb[1].trim() });
            }
        }

        items.push({
            id,
            status,
            file: fileMatch ? fileMatch[1] : undefined,
            startLine: linesMatch ? parseInt(linesMatch[1], 10) : undefined,
            endLine: linesMatch ? parseInt(linesMatch[2], 10) : undefined,
            language: codeMatch ? codeMatch[1].trim() || undefined : undefined,
            targetCode: codeMatch ? codeMatch[2].replace(/\n$/, '') : undefined,
            comments
        });
    }
    return items;
}

/** Serialize a review item back to the sidecar XML block. */
export function serializeReviewItem(item: ReviewItem): string {
    const lines = item.startLine !== undefined && item.endLine !== undefined
        ? `Lines: ${item.startLine}-${item.endLine}`
        : 'Lines: 0-0';
    const commentBlocks = item.comments
        .map(c => `<comment author="${c.author}">\n${c.text}\n</comment>`)
        .join('\n\n');

    return `<review_item id="${item.id}" status="${item.status}">
<location>
File: \`${item.file ?? ''}\`
${lines}
</location>

<target_code>
\`\`\`${item.language ?? ''}
${item.targetCode ?? ''}
\`\`\`
</target_code>

${commentBlocks}
</review_item>`;
}

/** Build a full sidecar document (header + serialized items) from a list of items. */
export function buildSidecarContent(fileName: string, items: ReviewItem[]): string {
    const header = `# Review Comments for \`${fileName}\``;
    
    const pendingItems = items.filter(i => i.status !== 'resolved');
    const resolvedItems = items.filter(i => i.status === 'resolved');
    
    let content = `${header}\n`;
    
    if (pendingItems.length > 0) {
        content += `\n${pendingItems.map(serializeReviewItem).join('\n\n')}\n`;
    }
    
    if (resolvedItems.length > 0) {
        content += `\n<!-- COSTEER_RESOLVED_START\n\n${resolvedItems.map(serializeReviewItem).join('\n\n')}\n\nCOSTEER_RESOLVED_END -->\n`;
    }
    
    return content;
}

/** Count pending vs resolved review items. */
export function countReviewItems(content: string): SidecarStatusCounts {
    const counts: SidecarStatusCounts = { pending: 0, resolved: 0 };
    for (const item of parseReviewItems(content)) {
        if (item.status === 'resolved') {
            counts.resolved++;
        } else {
            counts.pending++;
        }
    }
    return counts;
}

/** Read a sidecar from disk and count its review items. Missing file => all zeros. */
export function readSidecarCounts(sidecarPath: string): SidecarStatusCounts {
    if (!fs.existsSync(sidecarPath)) {
        return { pending: 0, resolved: 0 };
    }
    try {
        return countReviewItems(fs.readFileSync(sidecarPath, 'utf8'));
    } catch {
        return { pending: 0, resolved: 0 };
    }
}
