import * as vscode from 'vscode';

/** Cap the in-memory buffer so a long-running extension host doesn't leak memory. */
const MAX_LOGGED_LINES = 1000;

class Logger {
    private outputChannel?: vscode.OutputChannel;
    private logToConsole = false;
    public loggedLines: string[] = []; // Expose for test verification (bounded ring buffer)

    private getChannel(): vscode.OutputChannel | undefined {
        if (!this.outputChannel) {
            try {
                this.outputChannel = vscode.window.createOutputChannel('Co-Steer');
            } catch (e) {
                // Safe fallback if called in an environment where window is unavailable
            }
        }
        return this.outputChannel;
    }

    private formatValue(val: any): string {
        if (val === null || val === undefined) {
            return 'null';
        }
        if (val instanceof Error) {
            return this.formatStringValue(val.stack || val.message);
        }
        if (typeof val === 'object') {
            try {
                return this.formatStringValue(JSON.stringify(val));
            } catch (e) {
                return this.formatStringValue(String(val));
            }
        }
        if (typeof val === 'string') {
            return this.formatStringValue(val);
        }
        return String(val);
    }

    private formatStringValue(str: string): string {
        // If string contains spaces, quotes, equals, or backslashes, wrap and escape
        if (/\s|["'=]/.test(str)) {
            return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        return str;
    }

    private write(level: string, msg: string, context?: Record<string, any>) {
        const parts: string[] = [];
        parts.push(`level=${level}`);
        parts.push(`msg=${this.formatStringValue(msg)}`);

        if (context) {
            for (const [key, value] of Object.entries(context)) {
                parts.push(`${key}=${this.formatValue(value)}`);
            }
        }

        const line = parts.join(' ');
        this.loggedLines.push(line);
        if (this.loggedLines.length > MAX_LOGGED_LINES) {
            this.loggedLines.shift();
        }

        const channel = this.getChannel();
        if (channel) {
            channel.appendLine(line);
        }
        if (this.logToConsole) {
            console.log(line);
        }
    }

    public info(msg: string, context?: Record<string, any>) {
        this.write('INFO', msg, context);
    }

    public warn(msg: string, context?: Record<string, any>) {
        this.write('WARN', msg, context);
    }

    public error(msg: string, context?: Record<string, any>) {
        this.write('ERROR', msg, context);
    }

    public debug(msg: string, context?: Record<string, any>) {
        this.write('DEBUG', msg, context);
    }

    public counter(name: string, context?: Record<string, any>, delta = 1) {
        this.write('INFO', 'metric.counter', { name, delta, ...context });
    }

    public histogram(name: string, value: number, context?: Record<string, any>) {
        this.write('INFO', 'metric.histogram', { name, value, ...context });
    }

    public clearLogs() {
        this.loggedLines = [];
    }

    public setLogToConsole(enable: boolean) {
        this.logToConsole = enable;
    }

    public dispose() {
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = undefined;
        }
    }
}

export const logger = new Logger();
