import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        
        // Pass a mock workspace folder for testing
        const testWorkspace = path.resolve(__dirname, '../../test-fixtures');

        // Download VS Code, unzip it and run the integration test.
        // Explicitly clear ELECTRON_RUN_AS_NODE so that Code.exe runs as the VS Code GUI,
        // not as a plain Node.js process. Claude Code sets this env var; without clearing
        // it, Electron treats the workspace path as the Node main-module entry point and
        // crashes with "Cannot find module 'test-fixtures'".
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [testWorkspace, '--disable-extensions', '--disable-updates'],
            extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined }
        });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exit(1);
    }
}

main();
