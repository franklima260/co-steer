import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export type ArtifactState = 'pending' | 'iterating' | 'resolved';

/**
 * Tracks the transient review state of each artifact (keyed by the original file's fsPath).
 *
 * The set of artifacts itself is discovered by scanning for `.review.md` sidecars; this
 * store only records ephemeral state that can't be read off disk — chiefly whether an
 * agent iteration is currently running. Persistent "pending vs resolved" is derived from
 * the sidecar contents (see utils/sidecar), but a transient state recorded here always
 * wins so the UI reflects, e.g., "iterating" while a spawn is in flight.
 */
export class ArtifactStateStore {
    private states = new Map<string, ArtifactState>();
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    public set(filePath: string, state: ArtifactState): void {
        const prev = this.states.get(filePath);
        if (prev === state) {
            return;
        }
        this.states.set(filePath, state);
        logger.info('ArtifactStateStore: state changed', { filePath, from: prev ?? 'none', to: state });
        this._onDidChange.fire();
    }

    public get(filePath: string): ArtifactState | undefined {
        return this.states.get(filePath);
    }

    public clear(filePath: string): void {
        if (this.states.delete(filePath)) {
            this._onDidChange.fire();
        }
    }

    public dispose(): void {
        this._onDidChange.dispose();
    }
}
