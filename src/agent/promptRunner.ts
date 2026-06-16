import * as vscode from 'vscode';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { buildAgentSpawn } from './spawn';
import { logger } from '../utils/logger';

export interface RunAsPromptOptions {
    filePath: string;
    agentCommand?: string;
    agentArgs?: string[];
    prefix: string;
}

/**
 * Post-approval handoff: concatenate a standard prefix with the approved artifact's
 * contents and feed it to the configured agent via stdin. If no agent is configured,
 * fall back to copying the assembled prompt to the clipboard so the user can paste it.
 *
 * Returns true if the prompt was actually piped to an agent process.
 */
export async function runAsPrompt(options: RunAsPromptOptions): Promise<boolean> {
    const { filePath, agentCommand, agentArgs = [], prefix } = options;

    let body: string;
    try {
        body = await fs.promises.readFile(filePath, 'utf8');
    } catch (err: any) {
        logger.counter('prompt.run', { outcome: 'read_error' });
        logger.error('runAsPrompt: failed to read artifact', { error: err.message, filePath });
        vscode.window.showErrorMessage(`Could not read artifact to run as prompt: ${err.message}`);
        return false;
    }

    const prompt = `${prefix}\n\n${body}`;

    if (!agentCommand) {
        // No agent to pipe into — make the prompt available to the user instead of silently
        // doing nothing (the old behavior).
        await vscode.env.clipboard.writeText(prompt);
        logger.counter('prompt.run', { outcome: 'clipboard' });
        logger.info('runAsPrompt: no agentCommand, copied prompt to clipboard', { filePath, bytes: prompt.length });
        vscode.window.showInformationMessage('No agent configured — approved prompt copied to clipboard.');
        return false;
    }

    return new Promise<boolean>(resolve => {
        logger.info('runAsPrompt: piping prompt to agent', { filePath, command: agentCommand, bytes: prompt.length });
        const start = Date.now();
        // buildAgentSpawn handles Windows .cmd shims safely; the prompt goes over stdin.
        const invocation = buildAgentSpawn(agentCommand, agentArgs);
        let child: child_process.ChildProcess;
        try {
            child = child_process.spawn(invocation.command, invocation.args, invocation.options);
        } catch (err: any) {
            logger.counter('prompt.run', { outcome: 'spawn_throw' });
            logger.error('runAsPrompt: spawn threw', { error: err.message, command: agentCommand });
            vscode.window.showErrorMessage(`Failed to launch agent: ${err.message}`);
            resolve(false);
            return;
        }
        let stderr = '';
        // A failed spawn emits BOTH 'error' and 'close'; settle exactly once so the user
        // doesn't get two conflicting toasts.
        let settled = false;
        const settle = (value: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };

        child.on('error', err => {
            logger.counter('prompt.run', { outcome: 'spawn_error' });
            logger.error('runAsPrompt: failed to spawn agent', { error: err.message, command: agentCommand });
            vscode.window.showErrorMessage(`Failed to launch agent: ${err.message}`);
            settle(false);
        });
        child.stderr?.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
            if (settled) {
                return; // 'error' already reported this failure
            }
            logger.histogram('prompt.run.duration_ms', Date.now() - start, { filePath });
            if (code === 0) {
                logger.counter('prompt.run', { outcome: 'success' });
                logger.info('runAsPrompt: agent completed', { filePath });
                vscode.window.showInformationMessage('Approved plan handed off to the agent.');
                settle(true);
            } else {
                logger.counter('prompt.run', { outcome: 'nonzero_exit' });
                logger.error('runAsPrompt: agent exited non-zero', { code, stderr, command: agentCommand });
                vscode.window.showErrorMessage(`Agent exited with code ${code}.`);
                settle(true); // it WAS piped, it just failed
            }
        });

        child.stdin?.end(prompt);
    });
}
