import * as child_process from 'child_process';

export interface AgentInvocation {
    command: string;
    args: string[];
    options: child_process.SpawnOptions;
}

/**
 * Build a cross-platform, injection-safe spawn invocation for a user-configured agent.
 *
 * Why this exists: on Windows the common AI CLIs are installed as `.cmd`/`.bat` shims
 * (e.g. an npm-installed `claude`). Those cannot be launched without a shell — `execFile`
 * with `shell:false` throws `EINVAL` synchronously. So on Windows we use a shell, but pass
 * a single pre-quoted command string instead of an args array. Windows filenames cannot
 * contain a double quote, so wrapping every token in quotes neutralizes spaces and shell
 * metacharacters (`&`, `|`, …) in an attacker-controlled artifact path — it cannot break
 * out of the quotes. On POSIX we never use a shell (execFile-style, fully safe).
 */
export function buildAgentSpawn(command: string, args: string[]): AgentInvocation {
    if (process.platform === 'win32') {
        const quoted = [command, ...args].map(quoteWindowsArg).join(' ');
        return { command: quoted, args: [], options: { shell: true, windowsHide: true } };
    }
    return { command, args, options: { shell: false } };
}

function quoteWindowsArg(arg: string): string {
    // Defensive: escape any embedded quotes (filenames can't contain them, but agent
    // config args theoretically could) then wrap the whole token in quotes.
    return `"${arg.replace(/"/g, '""')}"`;
}
