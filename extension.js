// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Main Extension Entry Point
// Registers all commands, status bar, and lifecycle management
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const path = require('path');
const scanner = require('./src/scanner');
const exporter = require('./src/exporter');
const importer = require('./src/importer');
const github = require('./src/github');
const syncState = require('./src/syncState');
const dashboard = require('./src/dashboard');

let statusBarItem = null;
let autoSyncTimer = null;

function activate(context) {
    console.log('[AG Sync] Activating...');

    // ── Status Bar ───────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusBarItem.command = 'agSync.dashboard';
    updateStatusBar('idle');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ── Register Commands ────────────────────────────────────────────────────

    // 1. Export
    context.subscriptions.push(vscode.commands.registerCommand('agSync.export', async () => {
        try {
            const selections = await pickCategories('Export');
            if (!selections) return;

            const outputDir = await pickOutputDir();
            if (!outputDir) return;

            updateStatusBar('exporting');
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AG Sync: Exporting...',
                cancellable: false
            }, async (progress) => {
                return await exporter.exportData(selections, outputDir, progress);
            });

            updateStatusBar('idle');
            const action = await vscode.window.showInformationMessage(
                `Exported ${result.manifest.totalFiles} files (${result.manifest.compressedSizeFormatted}) to ${path.basename(result.zipPath)}`,
                'Open Folder', 'OK'
            );
            if (action === 'Open Folder') {
                vscode.env.openExternal(vscode.Uri.file(path.dirname(result.zipPath)));
            }
            dashboard.refresh(context);
        } catch (e) {
            updateStatusBar('error');
            vscode.window.showErrorMessage(`Export failed: ${e.message}`);
        }
    }));

    // 2. Import
    context.subscriptions.push(vscode.commands.registerCommand('agSync.import', async () => {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                filters: { 'ZIP Archives': ['zip'] },
                title: 'Select AG Sync backup ZIP'
            });
            if (!uris || uris.length === 0) return;

            const zipPath = uris[0].fsPath;

            // Read manifest to show info
            let manifest = null;
            try { manifest = await importer.readManifest(zipPath); } catch (e) { }

            if (manifest) {
                const info = `From: ${manifest.sourceComputer || 'unknown'}\nDate: ${manifest.exportDate || 'unknown'}\nFiles: ${manifest.totalFiles || '?'}\nSize: ${manifest.totalSizeFormatted || '?'}`;
                const proceed = await vscode.window.showInformationMessage(
                    `Import backup?\n${info}`, { modal: true }, 'Import', 'Cancel'
                );
                if (proceed !== 'Import') return;
            }

            // Conflict mode
            const conflictMode = await vscode.window.showQuickPick(
                [
                    { label: 'Overwrite existing', description: 'Replace all conflicting files', value: 'overwrite' },
                    { label: 'Skip existing', description: 'Keep existing files, only add new', value: 'skip' },
                    { label: 'Newer wins', description: 'Keep whichever file is more recent', value: 'newer-wins' }
                ],
                { placeHolder: 'How should file conflicts be handled?' }
            );
            if (!conflictMode) return;

            updateStatusBar('importing');
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AG Sync: Importing...',
                cancellable: false
            }, async (progress) => {
                return await importer.importData(zipPath, null, conflictMode.value, progress);
            });

            updateStatusBar('idle');
            vscode.window.showInformationMessage(
                `Import complete: ${result.filesImported} files imported, ${result.filesSkipped} skipped, ${result.filesOverwritten} overwritten.`
            );
            dashboard.refresh(context);
        } catch (e) {
            updateStatusBar('error');
            vscode.window.showErrorMessage(`Import failed: ${e.message}`);
        }
    }));

    // 3. Dashboard
    context.subscriptions.push(vscode.commands.registerCommand('agSync.dashboard', () => {
        dashboard.createOrShow(context);
    }));

    // 4. GitHub Login
    context.subscriptions.push(vscode.commands.registerCommand('agSync.githubLogin', async () => {
        try {
            const ghAvail = github.isGhCliAvailable();
            if (ghAvail) {
                const user = github.getGhUsername();
                const state = syncState.loadState();
                if (state.githubRepo) {
                    vscode.window.showInformationMessage(
                        `Connected as ${user || 'unknown'} | Sync repo: ${state.githubRepo}`
                    );
                } else {
                    const action = await vscode.window.showInformationMessage(
                        `Connected as ${user || 'unknown'} via GitHub CLI. Set up a sync repo?`,
                        'Set Up Repo', 'Cancel'
                    );
                    if (action === 'Set Up Repo') {
                        await vscode.commands.executeCommand('agSync.githubSelectRepo');
                    }
                }
            } else {
                const choice = await vscode.window.showWarningMessage(
                    'GitHub CLI (gh) not found or not authenticated. Install gh CLI and run "gh auth login", or enter a PAT.',
                    'Enter PAT', 'Cancel'
                );
                if (choice === 'Enter PAT') {
                    const token = await vscode.window.showInputBox({
                        prompt: 'Enter your GitHub Personal Access Token',
                        password: true,
                        placeHolder: 'ghp_xxxx...',
                        ignoreFocusOut: true
                    });
                    if (token) {
                        await github.storeToken(context, token);
                        vscode.window.showInformationMessage('GitHub token saved.');
                    }
                }
            }
            dashboard.refresh(context);
        } catch (e) {
            vscode.window.showErrorMessage(`GitHub check failed: ${e.message}`);
        }
    }));

    // 5. GitHub Logout
    context.subscriptions.push(vscode.commands.registerCommand('agSync.githubLogout', async () => {
        await github.deleteToken(context);
        vscode.window.showInformationMessage('GitHub token removed.');
        dashboard.refresh(context);
    }));

    // 6. Select/Create Sync Repo
    context.subscriptions.push(vscode.commands.registerCommand('agSync.githubSelectRepo', async () => {
        if (!github.isGhCliAvailable()) {
            vscode.window.showErrorMessage('GitHub CLI not connected. Run "AG Sync: Connect GitHub Account" first.');
            return;
        }

        const user = github.getGhUsername();
        const choice = await vscode.window.showQuickPick(
            [
                { label: '$(plus) Create new sync repo', value: 'create' },
                { label: '$(repo) Use existing repo', value: 'existing' }
            ],
            { placeHolder: 'Create a new repo or use an existing one?' }
        );
        if (!choice) return;

        let repoFullName;

        if (choice.value === 'create') {
            const repoName = await vscode.window.showInputBox({
                prompt: 'Enter repo name for sync data',
                value: 'antigravity-sync-data',
                placeHolder: 'antigravity-sync-data'
            });
            if (!repoName) return;

            repoFullName = `${user}/${repoName}`;
            const result = await github.createSyncRepo(repoFullName);
            if (!result.success) {
                vscode.window.showErrorMessage(`Failed to create repo: ${result.error}`);
                return;
            }
            vscode.window.showInformationMessage(
                result.existing ? `Using existing repo: ${repoFullName}` : `Created repo: ${repoFullName}`
            );
        } else {
            const repos = github.listSyncRepos();
            if (repos.length === 0) {
                vscode.window.showWarningMessage('No repos found. Create one first.');
                return;
            }

            const pick = await vscode.window.showQuickPick(
                repos.map(r => ({
                    label: r.nameWithOwner,
                    description: r.description || '',
                    detail: r.isPrivate ? 'Private' : 'Public'
                })),
                { placeHolder: 'Select a repo for sync' }
            );
            if (!pick) return;
            repoFullName = pick.label;
        }

        const state = syncState.loadState();
        state.githubRepo = repoFullName;
        syncState.saveState(state);
        vscode.window.showInformationMessage(`Sync repo set to: ${repoFullName}`);
        dashboard.refresh(context);
    }));

    // 7. Push to GitHub
    context.subscriptions.push(vscode.commands.registerCommand('agSync.push', async () => {
        try {
            const state = syncState.loadState();
            if (!state.githubRepo) {
                const action = await vscode.window.showWarningMessage(
                    'No sync repo configured.', 'Configure Now', 'Cancel'
                );
                if (action === 'Configure Now') {
                    await vscode.commands.executeCommand('agSync.githubSelectRepo');
                }
                return;
            }

            // Use saved selections or pick new ones
            let selections = state.categorySelections;
            if (!selections) {
                selections = await pickCategories('Push');
                if (!selections) return;
            }

            updateStatusBar('pushing');
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AG Sync: Pushing to GitHub...',
                cancellable: false
            }, async (progress) => {
                return await github.pushToGithub(state, selections, progress);
            });

            updateStatusBar('idle');
            vscode.window.showInformationMessage(`Push complete: ${result.message}`);
            dashboard.refresh(context);
        } catch (e) {
            updateStatusBar('error');
            vscode.window.showErrorMessage(`Push failed: ${e.message}`);
        }
    }));

    // 8. Pull from GitHub
    context.subscriptions.push(vscode.commands.registerCommand('agSync.pull', async () => {
        try {
            const state = syncState.loadState();
            if (!state.githubRepo) {
                vscode.window.showWarningMessage('No sync repo configured.');
                return;
            }

            const conflictMode = vscode.workspace.getConfiguration('agSync').get('conflictResolution', 'ask');
            let resolvedMode = conflictMode;

            if (conflictMode === 'ask') {
                const pick = await vscode.window.showQuickPick(
                    [
                        { label: 'Overwrite local', value: 'overwrite' },
                        { label: 'Skip existing', value: 'skip' },
                        { label: 'Newer wins', value: 'newer-wins' }
                    ],
                    { placeHolder: 'How to handle conflicts?' }
                );
                if (!pick) return;
                resolvedMode = pick.value;
            }

            let selections = state.categorySelections;
            if (!selections) {
                const excludes = vscode.workspace.getConfiguration('agSync').get('excludeCategories', []);
                selections = scanner.getDefaultSelections(excludes);
            }

            updateStatusBar('pulling');
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AG Sync: Pulling from GitHub...',
                cancellable: false
            }, async (progress) => {
                return await github.pullFromGithub(state, selections, resolvedMode, progress);
            });

            updateStatusBar('idle');
            vscode.window.showInformationMessage(
                `Pull complete: ${result.filesImported} imported, ${result.filesSkipped} skipped.`
            );
            dashboard.refresh(context);
        } catch (e) {
            updateStatusBar('error');
            vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
        }
    }));

    // 9. Full Sync
    context.subscriptions.push(vscode.commands.registerCommand('agSync.fullSync', async () => {
        await vscode.commands.executeCommand('agSync.push');
        await vscode.commands.executeCommand('agSync.pull');
    }));

    // 10. Status
    context.subscriptions.push(vscode.commands.registerCommand('agSync.status', async () => {
        const state = syncState.loadState();
        let ghAvail = false;
        let ghUser = null;
        try { ghAvail = github.isGhCliAvailable(); if (ghAvail) ghUser = github.getGhUsername(); } catch (e) { }

        const lines = [
            `GitHub: ${ghAvail ? 'Connected (' + (ghUser || '?') + ')' : 'Not connected'}`,
            `Sync Repo: ${state.githubRepo || 'Not configured'}`,
            `Last Push: ${state.lastPushTime || 'Never'}`,
            `Last Pull: ${state.lastPullTime || 'Never'}`,
            '',
            'Categories: (use AG Sync: Scan Data for full file counts)'
        ];

        for (const [id, cat] of Object.entries(scanner.CATEGORIES)) {
            lines.push(`  ${cat.label}: ${cat.description}`);
        }

        const doc = await vscode.workspace.openTextDocument({
            content: lines.join('\n'),
            language: 'plaintext'
        });
        vscode.window.showTextDocument(doc, { preview: true });
    }));

    // 11. Select Categories
    context.subscriptions.push(vscode.commands.registerCommand('agSync.selectCategories', async () => {
        const selections = await pickCategories('Sync');
        if (!selections) return;
        const state = syncState.loadState();
        state.categorySelections = selections;
        syncState.saveState(state);
        vscode.window.showInformationMessage('Category selections saved.');
        dashboard.refresh(context);
    }));

    // 12. View Diff
    context.subscriptions.push(vscode.commands.registerCommand('agSync.viewDiff', async () => {
        const state = syncState.loadState();
        const excludes = vscode.workspace.getConfiguration('agSync').get('excludeCategories', []);
        const selections = state.categorySelections || scanner.getDefaultSelections(excludes);
        const { changes } = syncState.detectChanges(state, selections);

        const lines = [
            `Changes since last sync:`,
            `  Added:     ${changes.added.length}`,
            `  Modified:  ${changes.modified.length}`,
            `  Deleted:   ${changes.deleted.length}`,
            `  Unchanged: ${changes.unchanged.length}`,
            ''
        ];

        if (changes.added.length > 0) {
            lines.push('--- Added ---');
            changes.added.slice(0, 100).forEach(f => lines.push(`  + ${f}`));
            if (changes.added.length > 100) lines.push(`  ... and ${changes.added.length - 100} more`);
            lines.push('');
        }
        if (changes.modified.length > 0) {
            lines.push('--- Modified ---');
            changes.modified.slice(0, 100).forEach(f => lines.push(`  ~ ${f}`));
            if (changes.modified.length > 100) lines.push(`  ... and ${changes.modified.length - 100} more`);
            lines.push('');
        }
        if (changes.deleted.length > 0) {
            lines.push('--- Deleted ---');
            changes.deleted.slice(0, 100).forEach(f => lines.push(`  - ${f}`));
            if (changes.deleted.length > 100) lines.push(`  ... and ${changes.deleted.length - 100} more`);
        }

        const doc = await vscode.workspace.openTextDocument({
            content: lines.join('\n'), language: 'plaintext'
        });
        vscode.window.showTextDocument(doc, { preview: true });
    }));

    // 13. Reset Sync
    context.subscriptions.push(vscode.commands.registerCommand('agSync.resetSync', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Reset all sync state? This clears sync history and change tracking. Your data is NOT affected.',
            { modal: true }, 'Reset', 'Cancel'
        );
        if (confirm !== 'Reset') return;
        syncState.resetState();
        vscode.window.showInformationMessage('Sync state reset.');
        dashboard.refresh(context);
    }));

    // 14. Scan Data
    context.subscriptions.push(vscode.commands.registerCommand('agSync.scanData', async () => {
        const scanResult = scanner.scanAll();
        const lines = [`AG Data Scan (${scanResult.timestamp})`, `Root: ${scanResult.agRoot}`, ''];
        for (const [id, cat] of Object.entries(scanResult.categories)) {
            lines.push(`${cat.label}: ${cat.fileCount} files (${cat.totalSizeFormatted})`);
        }
        lines.push('', `Total: ${scanResult.grandTotalFiles} files (${scanResult.grandTotalSizeFormatted})`);
        const doc = await vscode.workspace.openTextDocument({
            content: lines.join('\n'), language: 'plaintext'
        });
        vscode.window.showTextDocument(doc, { preview: true });
    }));

    // 15. Auto-Sync Toggle
    context.subscriptions.push(vscode.commands.registerCommand('agSync.autoSyncToggle', async () => {
        const config = vscode.workspace.getConfiguration('agSync');
        const current = config.get('autoSync', false);
        await config.update('autoSync', !current, vscode.ConfigurationTarget.Global);
        if (!current) {
            startAutoSync(context);
            vscode.window.showInformationMessage('Auto-sync enabled.');
        } else {
            stopAutoSync();
            vscode.window.showInformationMessage('Auto-sync disabled.');
        }
    }));

    // ── Auto-sync on startup ─────────────────────────────────────────────────
    const config = vscode.workspace.getConfiguration('agSync');
    if (config.get('autoSync', false)) {
        startAutoSync(context);
    }

    console.log('[AG Sync] Activated successfully. 15 commands registered.');
}

// ── Helper: Category picker ──────────────────────────────────────────────────

async function pickCategories(actionLabel) {
    const excludes = vscode.workspace.getConfiguration('agSync').get('excludeCategories', []);
    const state = syncState.loadState();
    const savedSelections = state.categorySelections;

    // Use CATEGORIES definitions directly — no slow full scan
    const items = Object.entries(scanner.CATEGORIES).map(([id, cat]) => {
        const isIncluded = savedSelections ? savedSelections[id] !== false : !excludes.includes(id);
        return {
            label: cat.label,
            description: cat.description,
            picked: isIncluded,
            categoryId: id
        };
    });

    const picks = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `Select categories to ${actionLabel}`,
        title: `AG Sync: ${actionLabel} Categories`
    });

    if (!picks) return null;

    const selections = {};
    for (const item of items) {
        selections[item.categoryId] = picks.some(p => p.categoryId === item.categoryId);
    }
    return selections;
}

// ── Helper: Output directory picker ──────────────────────────────────────────

async function pickOutputDir() {
    const config = vscode.workspace.getConfiguration('agSync');
    const defaultPath = config.get('defaultExportPath', '');

    if (defaultPath) return defaultPath;

    const choice = await vscode.window.showQuickPick(
        [
            { label: 'Desktop', value: 'desktop' },
            { label: 'Choose folder...', value: 'pick' }
        ],
        { placeHolder: 'Where to save the export?' }
    );

    if (!choice) return null;
    if (choice.value === 'desktop') {
        const os = require('os');
        return require('path').join(os.homedir(), 'Desktop');
    }

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        title: 'Select export directory'
    });
    return uris && uris.length > 0 ? uris[0].fsPath : null;
}

// ── Status Bar ───────────────────────────────────────────────────────────────

function updateStatusBar(state) {
    if (!statusBarItem) return;
    const states = {
        idle: { text: '$(cloud) AG Sync', tooltip: 'Click to open AG Sync Dashboard', color: undefined },
        exporting: { text: '$(sync~spin) Exporting...', tooltip: 'Exporting AG data...', color: '#58a6ff' },
        importing: { text: '$(sync~spin) Importing...', tooltip: 'Importing AG data...', color: '#58a6ff' },
        pushing: { text: '$(cloud-upload) Pushing...', tooltip: 'Pushing to GitHub...', color: '#d29922' },
        pulling: { text: '$(cloud-download) Pulling...', tooltip: 'Pulling from GitHub...', color: '#3fb950' },
        error: { text: '$(error) AG Sync Error', tooltip: 'An error occurred', color: '#f85149' }
    };
    const s = states[state] || states.idle;
    statusBarItem.text = s.text;
    statusBarItem.tooltip = s.tooltip;
    statusBarItem.color = s.color;
}

// ── Auto-Sync ────────────────────────────────────────────────────────────────

function startAutoSync(context) {
    stopAutoSync();
    const intervalMin = vscode.workspace.getConfiguration('agSync').get('autoSyncIntervalMinutes', 30);
    autoSyncTimer = setInterval(async () => {
        try {
            const state = syncState.loadState();
            if (state.githubRepo) {
                await vscode.commands.executeCommand('agSync.push');
            }
        } catch (e) {
            console.error('[AG Sync] Auto-sync error:', e.message);
        }
    }, intervalMin * 60 * 1000);
    console.log(`[AG Sync] Auto-sync started (every ${intervalMin}min)`);
}

function stopAutoSync() {
    if (autoSyncTimer) {
        clearInterval(autoSyncTimer);
        autoSyncTimer = null;
    }
}

function deactivate() {
    stopAutoSync();
    console.log('[AG Sync] Deactivated.');
}

module.exports = { activate, deactivate };
