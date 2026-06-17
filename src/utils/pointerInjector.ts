import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

// Cache to avoid reading language-configuration.json repeatedly
const commentSyntaxCache = new Map<string, CommentSyntax>();

export interface CommentSyntax {
    lineComment?: string;
    blockComment?: [string, string];
}

/**
 * Strips comments from JSON string
 */
function stripComments(jsonString: string): string {
    return jsonString.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
}

/**
 * Finds the comment syntax for a languageId by querying VS Code's extensions
 */
export function getCommentSyntaxForLanguage(languageId: string): CommentSyntax | undefined {
    if (commentSyntaxCache.has(languageId)) {
        return commentSyntaxCache.get(languageId);
    }

    // Direct defaults for common languages as fail-safe fallback before querying disk
    const commonDefaults: Record<string, CommentSyntax> = {
        'javascript': { lineComment: '//' },
        'typescript': { lineComment: '//' },
        'javascriptreact': { lineComment: '//', blockComment: ['{/*', '*/}'] },
        'typescriptreact': { lineComment: '//', blockComment: ['{/*', '*/}'] },
        'python': { lineComment: '#' },
        'go': { lineComment: '//' },
        'c': { lineComment: '//', blockComment: ['/*', '*/'] },
        'cpp': { lineComment: '//', blockComment: ['/*', '*/'] },
        'csharp': { lineComment: '//' },
        'java': { lineComment: '//' },
        'rust': { lineComment: '//' },
        'ruby': { lineComment: '#' },
        'php': { lineComment: '//', blockComment: ['/*', '*/'] },
        'html': { blockComment: ['<!--', '-->'] },
        'xml': { blockComment: ['<!--', '-->'] },
        'css': { blockComment: ['/*', '*/'] },
        'yaml': { lineComment: '#' },
        'ini': { lineComment: ';' },
        'shellscript': { lineComment: '#' },
        'bat': { lineComment: 'REM' },
        'powershell': { lineComment: '#' },
        'markdown': { blockComment: ['<!--', '-->'] }
    };

    for (const extension of vscode.extensions.all) {
        const packageJSON = extension.packageJSON;
        if (!packageJSON || !packageJSON.contributes || !packageJSON.contributes.languages) {
            continue;
        }

        const languages = packageJSON.contributes.languages;
        if (!Array.isArray(languages)) {
            continue;
        }

        const langContrib = languages.find((l: any) => l.id === languageId);
        if (langContrib && langContrib.configuration) {
            const configPath = path.isAbsolute(langContrib.configuration)
                ? langContrib.configuration
                : path.join(extension.extensionPath, langContrib.configuration);

            if (fs.existsSync(configPath)) {
                try {
                    const rawContent = fs.readFileSync(configPath, 'utf8');
                    const cleanContent = stripComments(rawContent);
                    const config = JSON.parse(cleanContent);
                    if (config && config.comments) {
                        const syntax: CommentSyntax = {};
                        if (typeof config.comments.lineComment === 'string') {
                            syntax.lineComment = config.comments.lineComment;
                        }
                        if (Array.isArray(config.comments.blockComment) && config.comments.blockComment.length === 2) {
                            syntax.blockComment = [config.comments.blockComment[0], config.comments.blockComment[1]];
                        }
                        if (syntax.lineComment || syntax.blockComment) {
                            commentSyntaxCache.set(languageId, syntax);
                            return syntax;
                        }
                    }
                } catch (err: any) {
                    logger.debug('Error parsing language configuration file', { path: configPath, error: err.message });
                }
            }
        }
    }

    if (commonDefaults[languageId]) {
        commentSyntaxCache.set(languageId, commonDefaults[languageId]);
        return commonDefaults[languageId];
    }

    return undefined;
}

/**
 * Gets the custom syntax from configuration overrides
 */
export function getCustomCommentSyntax(languageId: string, fileExtension: string): CommentSyntax | undefined {
    const config = vscode.workspace.getConfiguration('co-steer');
    const custom = config.get<Record<string, any>>('customCommentSyntaxes') || {};

    // Check by languageId
    let val = custom[languageId];
    if (!val && fileExtension) {
        // Check by extension (e.g. ".json")
        val = custom[fileExtension] || custom[fileExtension.replace(/^\./, '')];
    }

    if (val) {
        if (typeof val === 'string') {
            return { lineComment: val };
        }
        if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string' && typeof val[1] === 'string') {
            return { blockComment: [val[0], val[1]] };
        }
    }

    return undefined;
}

/**
 * Helper to construct the pointer comment line
 */
function makePointerComment(syntax: CommentSyntax, relativeSidecarPath: string): string {
    const message = `[Co-Steer] pending review: ${relativeSidecarPath}`;
    if (syntax.lineComment) {
        return `${syntax.lineComment} ${message}`;
    }
    if (syntax.blockComment) {
        return `${syntax.blockComment[0]} ${message} ${syntax.blockComment[1]}`;
    }
    throw new Error('Invalid comment syntax configuration');
}

/**
 * Injects the sidecar pointer into the top of the file
 */
export async function injectPointer(filePath: string, languageId: string) {
    logger.info('injectPointer: starting', { filePath, languageId });
    if (!fs.existsSync(filePath)) {
        logger.counter('co-steer.pointer.inject', { outcome: 'file_not_found' });
        throw new Error(`Target file not found: ${filePath}`);
    }

    const fileExt = path.extname(filePath);
    let syntax = getCustomCommentSyntax(languageId, fileExt) || getCommentSyntaxForLanguage(languageId);

    if (!syntax) {
        logger.counter('co-steer.pointer.inject', { outcome: 'unknown_syntax' });
        throw new Error(`Unknown comment syntax for languageId "${languageId}".`);
    }

    const sidecarPath = `${filePath}.review.md`;
    const relativeSidecarPath = vscode.workspace.asRelativePath(sidecarPath);
    const pointerLine = makePointerComment(syntax, relativeSidecarPath);

    let content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    // Check if pointer is already present on any of the first few lines
    const existingIndex = lines.findIndex(line => line.includes('[Co-Steer] pending review:'));
    
    if (existingIndex !== -1) {
        // Update the pointer line if it changed
        if (lines[existingIndex] !== pointerLine) {
            lines[existingIndex] = pointerLine;
            fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
            logger.info('injectPointer: updated existing pointer line', { filePath });
        } else {
            logger.info('injectPointer: pointer already exists and matches', { filePath });
        }
        logger.counter('co-steer.pointer.inject', { outcome: 'success_already_present' });
        return;
    }

    // Insert pointer line
    // If line 1 is a shebang (e.g. #!), insert on line 2
    if (lines.length > 0 && lines[0].startsWith('#!')) {
        lines.splice(1, 0, pointerLine);
    } else {
        lines.splice(0, 0, pointerLine);
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    logger.info('injectPointer: injected pointer successfully', { filePath });
    logger.counter('co-steer.pointer.inject', { outcome: 'success' });
}

/**
 * Removes the sidecar pointer from the file
 */
export async function removePointer(filePath: string) {
    logger.info('removePointer: starting', { filePath });
    if (!fs.existsSync(filePath)) {
        logger.counter('co-steer.pointer.remove', { outcome: 'file_not_found' });
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    const initialLength = lines.length;
    const filteredLines = lines.filter(line => !line.includes('[Co-Steer] pending review:'));

    if (filteredLines.length !== initialLength) {
        fs.writeFileSync(filePath, filteredLines.join('\n'), 'utf8');
        logger.info('removePointer: removed pointer line', { filePath });
        logger.counter('co-steer.pointer.remove', { outcome: 'success' });
    } else {
        logger.info('removePointer: no pointer line found to remove', { filePath });
        logger.counter('co-steer.pointer.remove', { outcome: 'not_found' });
    }
}
