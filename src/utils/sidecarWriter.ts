import * as fs from 'fs';
import * as path from 'path';
import {
    ReviewStatus,
    parseReviewItems,
    buildSidecarContent,
    generateReviewId
} from './sidecar';

/**
 * Shared, UI-agnostic mutations of a `.review.md` sidecar. Both the native comment
 * controller and the rendered Markdown review panel go through these so they always
 * produce the same schema.
 */

export function sidecarPathFor(originalFilePath: string): string {
    return `${originalFilePath}.review.md`;
}

async function readItems(sidecarPath: string) {
    const content = fs.existsSync(sidecarPath)
        ? await fs.promises.readFile(sidecarPath, 'utf8')
        : '';
    return parseReviewItems(content);
}

/** Slice the inclusive 1-based line range out of the source file for the target_code block. */
async function extractTargetCode(originalFilePath: string, startLine: number, endLine: number): Promise<string> {
    if (!fs.existsSync(originalFilePath)) {
        return '';
    }
    const lines = (await fs.promises.readFile(originalFilePath, 'utf8')).split(/\r?\n/);
    return lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
}

/** Add a new review item anchored to a source line range. Returns the new item's id. */
export async function addNewComment(params: {
    originalFilePath: string;
    startLine: number;
    endLine: number;
    text: string;
    author: string;
}): Promise<string> {
    const { originalFilePath, startLine, endLine, text, author } = params;
    const sidecarPath = sidecarPathFor(originalFilePath);
    const fileName = path.basename(originalFilePath);
    const items = await readItems(sidecarPath);
    const id = generateReviewId();

    items.push({
        id,
        status: 'pending',
        file: fileName,
        startLine,
        endLine,
        language: path.extname(originalFilePath).substring(1),
        targetCode: await extractTargetCode(originalFilePath, startLine, endLine),
        comments: [{ author, text }]
    });

    await fs.promises.writeFile(sidecarPath, buildSidecarContent(fileName, items), 'utf8');
    return id;
}

/** Append a reply comment to an existing review item. */
export async function addReply(originalFilePath: string, id: string, text: string, author: string): Promise<boolean> {
    const sidecarPath = sidecarPathFor(originalFilePath);
    const fileName = path.basename(originalFilePath);
    const items = await readItems(sidecarPath);
    const item = items.find(i => i.id === id);
    if (!item) {
        return false;
    }
    item.comments.push({ author, text });
    await fs.promises.writeFile(sidecarPath, buildSidecarContent(fileName, items), 'utf8');
    return true;
}

/** Set a review item's status (e.g. resolve/reopen from the UI). */
export async function setStatus(originalFilePath: string, id: string, status: ReviewStatus): Promise<boolean> {
    const sidecarPath = sidecarPathFor(originalFilePath);
    const fileName = path.basename(originalFilePath);
    const items = await readItems(sidecarPath);
    const item = items.find(i => i.id === id);
    if (!item) {
        return false;
    }
    item.status = status;
    await fs.promises.writeFile(sidecarPath, buildSidecarContent(fileName, items), 'utf8');
    return true;
}
