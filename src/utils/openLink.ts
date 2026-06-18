import * as vscode from 'vscode';

export const openLinkHelper = {
    openExternal: async (uri: vscode.Uri): Promise<boolean> => {
        const mockOpen = (globalThis as any).__mockOpenExternal;
        if (mockOpen) {
            return mockOpen(uri);
        }
        return vscode.env.openExternal(uri);
    }
};
