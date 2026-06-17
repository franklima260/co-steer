import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { ArtifactStateStore, ArtifactState } from '../state/ArtifactStateStore';
import { readSidecarCounts } from '../utils/sidecar';

export class ArtifactTreeProvider implements vscode.TreeDataProvider<ArtifactItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ArtifactItem | undefined | void> = new vscode.EventEmitter<ArtifactItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ArtifactItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private readonly stateStore?: ArtifactStateStore) {
        // Re-render whenever transient state (e.g. "iterating") changes.
        this.stateStore?.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ArtifactItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ArtifactItem): Thenable<ArtifactItem[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            const startTime = Date.now();
            logger.debug('ArtifactTreeProvider: fetching children');
            return vscode.workspace.findFiles('**/*.review.md', '**/node_modules/**').then(
                uris => {
                    const duration = Date.now() - startTime;
                    logger.histogram('tree.fetch_duration_ms', duration);
                    logger.counter('tree.fetch', { outcome: 'success', count: uris.length });

                    const items = uris.map(uri => {
                        const sidecarPath = uri.fsPath;
                        const originalFilePath = sidecarPath.replace('.review.md', '');
                        const label = vscode.workspace.asRelativePath(originalFilePath);

                        // Transient state (iterating) wins; otherwise derive from sidecar contents.
                        const counts = readSidecarCounts(sidecarPath);
                        const transient = this.stateStore?.get(originalFilePath);
                        // "Resolved" only when there is at least one item and none are
                        // pending; a freshly-started review (no items yet) stays pending.
                        const state: ArtifactState =
                            transient === 'iterating' ? 'iterating'
                            : counts.pending === 0 && counts.resolved > 0 ? 'resolved'
                            : 'pending';

                        return new ArtifactItem(
                            label,
                            vscode.TreeItemCollapsibleState.None,
                            {
                                command: 'co-steer.open',
                                title: 'Open Artifact',
                                arguments: [vscode.Uri.file(originalFilePath)]
                            },
                            vscode.Uri.file(originalFilePath),
                            state,
                            counts.pending
                        );
                    });
                    logger.debug('ArtifactTreeProvider: children loaded', { count: items.length });
                    return items;
                },
                err => {
                    logger.counter('tree.fetch', { outcome: 'error' });
                    logger.error('ArtifactTreeProvider: failed to find files', { error: err.message });
                    throw err;
                }
            );
        }
    }
}

const STATE_PRESENTATION: Record<ArtifactState, { description: string; icon: string; color?: string }> = {
    pending: { description: 'Pending review', icon: 'comment-unresolved', color: 'charts.yellow' },
    iterating: { description: 'Iterating…', icon: 'sync~spin', color: 'charts.blue' },
    resolved: { description: 'Resolved', icon: 'check', color: 'charts.green' }
};

export class ArtifactItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command,
        public readonly originalUri?: vscode.Uri,
        public readonly state: ArtifactState = 'pending',
        public readonly pendingCount: number = 0
    ) {
        super(label, collapsibleState);
        const presentation = STATE_PRESENTATION[state];
        const suffix = state === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : '';
        this.description = `${presentation.description}${suffix}`;
        this.tooltip = `${label} — ${presentation.description}${suffix}`;
        this.iconPath = new vscode.ThemeIcon(
            presentation.icon,
            presentation.color ? new vscode.ThemeColor(presentation.color) : undefined
        );
        this.contextValue = `artifact:${state}`;
    }
}
