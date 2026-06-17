import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const COSTEER_MARKER_START = '<!-- COSTEER_START -->';
const COSTEER_MARKER_END = '<!-- COSTEER_END -->';

const COSTEER_INSTRUCTIONS = `
### Co-Steer Agent Instructions
${COSTEER_MARKER_START}
When editing any file in this workspace, check if a sidecar file named \`<filename>.review.md\` exists.
If the sidecar file exists, read its contents and address any review comments marked as pending (e.g. status="pending").
Ignore any review items inside the <!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END --> block.
Once you address a review comment, update its status to "resolved" in the sidecar.
Do not ignore these sidecar comments.
${COSTEER_MARKER_END}
`;

export const COSTEER_RULES_VERSION = '2';

export async function checkAndPromptWorkspaceRules(context: vscode.ExtensionContext) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return;
    }

    const rootPath = folders[0].uri.fsPath;
    const storedVersion = context.workspaceState.get<string>('costeer.rulesVersion', '');

    if (storedVersion === COSTEER_RULES_VERSION) {
        return;
    }

    // Check if rules are already present in ANY of the files.
    let rulesPresent = false;
    const rulesFiles = [
        '.cursorrules',
        '.github/copilot-instructions.md',
        'claude.json',
        '.clauderc',
        '.windsurfrules',
        '.antigravityrules',
        'CLAUDE.md'
    ];

    for (const file of rulesFiles) {
        const filePath = path.join(rootPath, file);
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                if (content.includes(COSTEER_MARKER_START) || content.includes('Co-Steer Agent Instructions')) {
                    rulesPresent = true;
                    break;
                }
            } catch (e) {
                // ignore read errors
            }
        }
    }

    if (rulesPresent) {
        // Rules exist but version is outdated — silently reinject updated instructions.
        try {
            await generateWorkspaceRules(rootPath);
            await context.workspaceState.update('costeer.rulesVersion', COSTEER_RULES_VERSION);
            logger.info('Workspace rules automatically updated to version ' + COSTEER_RULES_VERSION);
        } catch (e) {
            logger.error('Failed to update workspace rules version', { error: e });
        }
        return;
    }

    const hasPrompted = context.workspaceState.get<boolean>('costeer.rulesPrompted', false);
    if (hasPrompted) {
        return;
    }

    const installAction = 'Generate Rules';
    const ignoreAction = 'Don\'t Ask Again';
    const result = await vscode.window.showInformationMessage(
        'Co-Steer: Workspace rules for AI agents (Cursor, Claude, Copilot, etc.) are missing. Would you like to generate them?',
        installAction,
        ignoreAction
    );

    if (result === installAction) {
        try {
            await generateWorkspaceRules(rootPath);
            await context.workspaceState.update('costeer.rulesPrompted', true);
            await context.workspaceState.update('costeer.rulesVersion', COSTEER_RULES_VERSION);
            logger.counter('co-steer.rules.generate', { outcome: 'success' });
            vscode.window.showInformationMessage('Co-Steer: Workspace rules generated successfully.');
        } catch (err: any) {
            logger.counter('co-steer.rules.generate', { outcome: 'error' });
            logger.error('Failed to generate workspace rules', { error: err.message });
            vscode.window.showErrorMessage(`Failed to generate rules: ${err.message}`);
        }
    } else if (result === ignoreAction) {
        await context.workspaceState.update('costeer.rulesPrompted', true);
        await context.workspaceState.update('costeer.rulesVersion', COSTEER_RULES_VERSION);
        logger.counter('co-steer.rules.generate', { outcome: 'ignored' });
    }
}

export async function generateWorkspaceRules(rootPath: string) {
    const rulesFiles = [
        '.cursorrules',
        '.github/copilot-instructions.md',
        'claude.json',
        '.clauderc',
        '.windsurfrules',
        '.antigravityrules',
        'CLAUDE.md'
    ];

    for (const file of rulesFiles) {
        const filePath = path.join(rootPath, file);
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        const isJson = file.endsWith('.json');
        if (isJson) {
            let jsonContent: any = {};
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    jsonContent = JSON.parse(content);
                } catch (e) {
                    // fallback to empty object if malformed JSON
                }
            }
            // Add or append rule
            if (!jsonContent.rules) {
                jsonContent.rules = [];
            }
            if (Array.isArray(jsonContent.rules)) {
                const newRule = 'When editing any file in this workspace, check if a Co-Steer sidecar file named `<filename>.review.md` exists. If it does, read and address the feedback comments inside it. Once addressed, change its status to "resolved" in the sidecar. Do NOT process review items inside <!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END --> — they are already resolved and must be left unchanged.';
                const idx = jsonContent.rules.findIndex((r: string) => typeof r === 'string' && (r.includes('Co-Steer') || r.includes('review.md')));
                if (idx !== -1) {
                    jsonContent.rules[idx] = newRule;
                } else {
                    jsonContent.rules.push(newRule);
                }
            }
            fs.writeFileSync(filePath, JSON.stringify(jsonContent, null, 2), 'utf8');
        } else {
            // Text/Markdown files
            let content = '';
            if (fs.existsSync(filePath)) {
                content = fs.readFileSync(filePath, 'utf8');
                if (content.includes(COSTEER_MARKER_START)) {
                    const regex = new RegExp(`${COSTEER_MARKER_START}[\\s\\S]*?${COSTEER_MARKER_END}`, 'g');
                    const newBlock = `${COSTEER_MARKER_START}\nWhen editing any file in this workspace, check if a sidecar file named \`<filename>.review.md\` exists.\nIf the sidecar file exists, read its contents and address any review comments marked as pending (e.g. status="pending").\nIgnore any review items inside the <!-- COSTEER_RESOLVED_START ... COSTEER_RESOLVED_END --> block.\nOnce you address a review comment, update its status to "resolved" in the sidecar.\nDo not ignore these sidecar comments.\n${COSTEER_MARKER_END}`;
                    content = content.replace(regex, newBlock);
                    fs.writeFileSync(filePath, content, 'utf8');
                } else {
                    if (content && !content.endsWith('\n')) {
                        content += '\n';
                    }
                    content += COSTEER_INSTRUCTIONS;
                    fs.writeFileSync(filePath, content, 'utf8');
                }
            } else {
                content = COSTEER_INSTRUCTIONS;
                fs.writeFileSync(filePath, content, 'utf8');
            }
        }
        logger.info('Workspace rules updated/created', { file });
    }
}
