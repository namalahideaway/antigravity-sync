// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — GitHub Sync Backend
// Push/pull AG data to/from a private GitHub repository
// All shell commands use 'cmd /c' for Windows EOF signal compliance
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const scanner = require('./scanner');
const syncState = require('./syncState');

const SYNC_BASE = path.join(os.tmpdir(), 'ag-sync');
const GITIGNORE_CONTENT = `
# AG Sync gitignore
node_modules/
*.vsix
.DS_Store
Thumbs.db
*.log
`.trim();

// Generate a unique staging dir per operation (avoids EBUSY on locked files from prior runs)
function makeSyncDir() {
    const dir = path.join(SYNC_BASE, `op-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Safe cleanup with retry for Windows file locks (antivirus, indexer, etc.)
function safeCleanup(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            if (attempt < 2) {
                // Wait a bit for Windows to release locks
                try { execSync('cmd /c timeout /t 1 /nobreak >nul 2>&1', { windowsHide: true, timeout: 3000 }); } catch (e2) { }
            }
        }
    }
    // Last resort: schedule cleanup via cmd
    try { execSync(`cmd /c "start /min cmd /c timeout /t 5 && rd /s /q "${dir}""`, { windowsHide: true }); } catch (e) { }
}

// Clean up old staging dirs from prior runs
function cleanOldStagingDirs() {
    try {
        if (!fs.existsSync(SYNC_BASE)) return;
        for (const entry of fs.readdirSync(SYNC_BASE)) {
            const full = path.join(SYNC_BASE, entry);
            try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { /* locked, skip */ }
        }
    } catch (e) { }
}

// ── Shell helper — ALL commands go through cmd /c ────────────────────────────
function shell(command, opts = {}) {
    const defaults = { encoding: 'utf8', windowsHide: true, timeout: 15000 };
    return execSync(`cmd /c ${command}`, { ...defaults, ...opts });
}

// ── Token management ─────────────────────────────────────────────────────────

async function storeToken(context, token) {
    await context.secrets.store('agSync.githubToken', token);
}

async function getToken(context) {
    return await context.secrets.get('agSync.githubToken');
}

async function deleteToken(context) {
    await context.secrets.delete('agSync.githubToken');
}

// ── GitHub CLI checks ────────────────────────────────────────────────────────

function isGhCliAvailable() {
    try {
        const result = shell('gh auth status 2>&1', { timeout: 8000 });
        return result.includes('Logged in');
    } catch (e) {
        // execSync throws on non-zero exit, but gh auth status may still
        // output "Logged in" on stderr captured by 2>&1
        try {
            if (e.stdout && e.stdout.includes('Logged in')) return true;
            if (e.stderr && e.stderr.includes('Logged in')) return true;
            if (e.output) {
                const combined = e.output.map(b => b ? b.toString() : '').join('');
                if (combined.includes('Logged in')) return true;
            }
        } catch (e2) { /* give up */ }
        return false;
    }
}

function getGhUsername() {
    try {
        const result = shell('gh auth status 2>&1', { timeout: 8000 });
        const match = result.match(/account\s+(\S+)/);
        return match ? match[1] : null;
    } catch (e) {
        // Same pattern — check stderr/stdout for account info
        try {
            const combined = [e.stdout, e.stderr, ...(e.output || [])].filter(Boolean).join(' ');
            const match = combined.match(/account\s+(\S+)/);
            return match ? match[1] : null;
        } catch (e2) { return null; }
    }
}

async function createSyncRepo(repoName) {
    try {
        const result = shell(
            `gh repo create ${repoName} --private --description "Antigravity Sync Data" 2>&1`,
            { timeout: 30000 }
        );
        return { success: true, url: result.trim() };
    } catch (e) {
        const msg = [e.stdout, e.stderr].filter(Boolean).join(' ');
        if (msg.includes('already exists')) {
            return { success: true, url: `https://github.com/${repoName}`, existing: true };
        }
        return { success: false, error: msg || e.message };
    }
}

function listSyncRepos() {
    try {
        const result = shell(
            'gh repo list --json nameWithOwner,description,isPrivate --limit 50 2>&1',
            { timeout: 15000 }
        );
        return JSON.parse(result);
    } catch (e) {
        return [];
    }
}

/**
 * Auto-create and configure a private sync repo if none exists.
 * Called automatically before push/pull so the user never has to set up manually.
 * Repo name: {username}/antigravity-sync-data (PRIVATE)
 */
function ensureRepo(state) {
    if (state.githubRepo) return state.githubRepo;

    if (!isGhCliAvailable()) {
        throw new Error('GitHub CLI not authenticated. Run: gh auth login');
    }

    const user = getGhUsername();
    if (!user) throw new Error('Could not determine GitHub username.');

    const repoName = `${user}/antigravity-sync-data`;

    // Create repo (idempotent — succeeds if already exists)
    try {
        shell(
            `gh repo create ${repoName} --private --description "Antigravity Sync Data (auto-created)" 2>&1`,
            { timeout: 30000 }
        );
    } catch (e) {
        const msg = [e.stdout, e.stderr].filter(Boolean).join(' ');
        if (!msg.includes('already exists')) {
            throw new Error(`Failed to create repo: ${msg || e.message}`);
        }
    }

    // Persist to state
    state.githubRepo = repoName;
    syncState.saveState(state);
    console.log(`[AG Sync] Auto-created private repo: ${repoName}`);
    return repoName;
}

// ── Git operations ───────────────────────────────────────────────────────────

function prepareLocalRepo(repoUrl, syncDir, progress) {
    try {
        progress?.report({ message: '[1/7] Cloning repo (this may take a moment)...' });
        shell(`git clone "${repoUrl}" "${syncDir}" 2>&1`, { timeout: 120000 });
        progress?.report({ message: '[1/7] Clone complete.' });
        return true;
    } catch (e) {
        progress?.report({ message: '[1/7] Empty repo — initializing fresh...' });
        shell('git init', { cwd: syncDir });
        shell(`git remote add origin "${repoUrl}"`, { cwd: syncDir });
        try { shell('git checkout -b main', { cwd: syncDir }); } catch (e2) { }
        return true;
    }
}

// ── Elapsed time helper ─────────────────────────────────────────────────────
function elapsed(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Tracked copy: reports progress every N files ────────────────────────────
function copyDirTracked(src, dst, tracker) {
    fs.mkdirSync(dst, { recursive: true });
    try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, entry.name), d = path.join(dst, entry.name);
            try {
                if (entry.isDirectory()) {
                    copyDirTracked(s, d, tracker);
                } else {
                    fs.copyFileSync(s, d);
                    tracker.copied++;
                    if (tracker.copied % 100 === 0) {
                        const pct = tracker.total > 0 ? Math.round((tracker.copied / tracker.total) * 100) : 0;
                        tracker.progress?.report({
                            message: `[3/7] Copying files: ${tracker.copied.toLocaleString()}/${tracker.total.toLocaleString()} (${pct}%, ${elapsed(tracker.startMs)})`,
                            increment: 1
                        });
                    }
                }
            } catch (e) { /* skip unreadable */ }
        }
    } catch (e) { }
}

// ── Quick file count (non-recursive, top-level only for speed) ──────────────
function quickCountFiles(dirs, baseDir) {
    let total = 0;
    for (const dir of dirs) {
        const p = path.join(baseDir, dir);
        try {
            const entries = fs.readdirSync(p, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory()) {
                    // Only go 1 level deep for estimation
                    try { total += fs.readdirSync(path.join(p, e.name)).length; } catch (e2) { total += 10; }
                } else {
                    total++;
                }
            }
        } catch (e) { }
    }
    return total;
}

async function pushToGithub(state, categorySelections, progress) {
    const t0 = Date.now();

    // Phase 0: Ensure repo
    progress?.report({ message: `[0/7] Checking repo config... (${elapsed(t0)})`, increment: 1 });
    ensureRepo(state);
    progress?.report({ message: `[0/7] Repo: ${state.githubRepo} (${elapsed(t0)})`, increment: 2 });

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    // Clean old staging dirs, then create a fresh unique one
    progress?.report({ message: `[1/7] Preparing staging area... (${elapsed(t0)})`, increment: 1 });
    cleanOldStagingDirs();
    const syncDir = makeSyncDir();

    try {
        // Phase 1: Clone/init repo
        progress?.report({ message: `[1/7] Cloning repo... (${elapsed(t0)})`, increment: 2 });
        prepareLocalRepo(repoUrl, syncDir, progress);
        progress?.report({ message: `[1/7] Repo ready. (${elapsed(t0)})`, increment: 2 });

        // Phase 2: Count files (reports per-category so user sees activity)
        progress?.report({ message: `[2/7] Counting files... (${elapsed(t0)})`, increment: 1 });
        const selectedCats = Object.keys(categorySelections).filter(id => categorySelections[id]);
        let estimatedTotal = 0;
        for (const catId of selectedCats) {
            const catDef = scanner.CATEGORIES[catId];
            if (!catDef) continue;
            let catCount = 0;
            for (const dir of (catDef.dirs || [])) {
                const p = path.join(scanner.AG_ROOT, dir);
                if (fs.existsSync(p)) catCount += countFiles(p);
            }
            catCount += (catDef.files || []).filter(f => fs.existsSync(path.join(scanner.AG_ROOT, f))).length;
            catCount += (catDef.parentFiles || []).filter(f => fs.existsSync(path.join(scanner.GEMINI_ROOT, f))).length;
            estimatedTotal += catCount;
            progress?.report({ message: `[2/7] Counted ${catDef.label}: ${catCount.toLocaleString()} files (total: ${estimatedTotal.toLocaleString()}, ${elapsed(t0)})` });
        }
        progress?.report({ message: `[2/7] ${estimatedTotal.toLocaleString()} files to stage. (${elapsed(t0)})`, increment: 2 });

        // Phase 3: Copy files with tracking
        const stagingAG = path.join(syncDir, 'antigravity');
        const stagingGR = path.join(syncDir, 'gemini-root');
        fs.mkdirSync(stagingAG, { recursive: true });
        fs.mkdirSync(stagingGR, { recursive: true });
        fs.writeFileSync(path.join(syncDir, '.gitignore'), GITIGNORE_CONTENT, 'utf8');

        const tracker = { copied: 0, total: estimatedTotal, progress, startMs: t0 };

        for (const catId of selectedCats) {
            const catDef = scanner.CATEGORIES[catId];
            if (!catDef) continue;

            progress?.report({ message: `[3/7] Staging ${catDef.label}... (${tracker.copied.toLocaleString()} files, ${elapsed(t0)})` });

            for (const dir of (catDef.dirs || [])) {
                const srcPath = path.join(scanner.AG_ROOT, dir);
                const dstPath = path.join(stagingAG, dir);
                if (fs.existsSync(srcPath)) {
                    copyDirTracked(srcPath, dstPath, tracker);
                }
            }

            for (const file of (catDef.files || [])) {
                const srcPath = path.join(scanner.AG_ROOT, file);
                if (fs.existsSync(srcPath)) {
                    const dstPath = path.join(stagingAG, file);
                    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                    fs.copyFileSync(srcPath, dstPath);
                    tracker.copied++;
                }
            }

            for (const file of (catDef.parentFiles || [])) {
                const srcPath = path.join(scanner.GEMINI_ROOT, file);
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, path.join(stagingGR, file));
                    tracker.copied++;
                }
            }
        }

        const totalFiles = tracker.copied;
        progress?.report({ message: `[3/7] Staged ${totalFiles.toLocaleString()} files. (${elapsed(t0)})`, increment: 10 });

        // Write sync metadata
        const syncMeta = {
            lastPush: new Date().toISOString(),
            machine: state.machineId,
            hostname: os.hostname(),
            categories: selectedCats,
            fileCount: totalFiles
        };
        fs.writeFileSync(path.join(syncDir, '_ag_sync_meta.json'), JSON.stringify(syncMeta, null, 2), 'utf8');

        // Phase 4: git add
        progress?.report({ message: `[4/7] git add — indexing ${totalFiles.toLocaleString()} files... (${elapsed(t0)})`, increment: 5 });
        const gitOpts = { cwd: syncDir, timeout: 300000 };
        shell('git add -A', gitOpts);
        progress?.report({ message: `[4/7] Index complete. (${elapsed(t0)})`, increment: 5 });

        // Check for changes
        try {
            const status = shell('git status --porcelain', gitOpts).trim();
            if (!status) {
                progress?.report({ message: `[4/7] No changes detected. (${elapsed(t0)})`, increment: 50 });
                return { success: true, message: 'No changes to push.', filesCount: 0 };
            }
        } catch (e) { }

        // Phase 5: Commit
        progress?.report({ message: `[5/7] Committing ${totalFiles.toLocaleString()} files... (${elapsed(t0)})`, increment: 5 });
        const commitMsg = `AG Sync: ${new Date().toISOString()} from ${os.hostname()} (${totalFiles} files)`;
        try {
            shell(`git commit -m "${commitMsg}"`, gitOpts);
        } catch (e) {
            const msg = [e.stdout, e.stderr].filter(Boolean).join(' ');
            if (msg.includes('nothing to commit')) return { success: true, message: 'Already up to date.', filesCount: 0 };
            throw e;
        }
        progress?.report({ message: `[5/7] Committed. (${elapsed(t0)})`, increment: 5 });

        // Phase 6: Push
        progress?.report({ message: `[6/7] Pushing to GitHub (this may take a while)... (${elapsed(t0)})`, increment: 5 });
        try {
            shell('git push -u origin main --force 2>&1', gitOpts);
        } catch (e) {
            try {
                shell('git push --set-upstream origin main --force 2>&1', gitOpts);
            } catch (e2) {
                throw new Error(`Push failed: ${e2.message}`);
            }
        }
        progress?.report({ message: `[6/7] Push complete. (${elapsed(t0)})`, increment: 10 });

        let commitSha = null;
        try { commitSha = shell('git rev-parse HEAD', gitOpts).trim(); } catch (e) { }

        // Phase 7: Finalize
        progress?.report({ message: `[7/7] Cleaning up... (${elapsed(t0)})`, increment: 2 });

        state.lastPushTime = new Date().toISOString();
        state.lastPushCommit = commitSha;
        state.categorySelections = categorySelections;

        const { currentHashes } = syncState.detectChanges(state, categorySelections);
        syncState.updateSyncHashes(state, currentHashes);

        syncState.addHistoryEntry(state, {
            action: 'push', commit: commitSha, filesCount: totalFiles, categories: selectedCats
        });

        const totalTime = elapsed(t0);
        progress?.report({ message: `Done! ${totalFiles.toLocaleString()} files in ${totalTime}`, increment: 5 });

        return { success: true, message: `Pushed ${totalFiles.toLocaleString()} files in ${totalTime}.`, filesCount: totalFiles, commit: commitSha };

    } finally {
        // Always clean up staging dir, even on error
        safeCleanup(syncDir);
    }
}

async function pullFromGithub(state, categorySelections, conflictMode, progress) {
    const t0 = Date.now();

    // Phase 0: Ensure repo
    progress?.report({ message: `[0/5] Checking repo config... (${elapsed(t0)})`, increment: 2 });
    ensureRepo(state);
    progress?.report({ message: `[0/5] Repo: ${state.githubRepo} (${elapsed(t0)})`, increment: 3 });

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    // Create unique staging dir
    cleanOldStagingDirs();
    const syncDir = makeSyncDir();

    try {
        // Phase 1: Clone
        progress?.report({ message: `[1/5] Cloning from GitHub (may take a moment)... (${elapsed(t0)})`, increment: 5 });

        try {
            shell(`git clone "${repoUrl}" "${syncDir}" 2>&1`, { timeout: 300000 });
        } catch (e) {
            throw new Error(`Clone failed: ${e.message}`);
        }
        progress?.report({ message: `[1/5] Clone complete. (${elapsed(t0)})`, increment: 10 });

        // Phase 2: Count remote files
        progress?.report({ message: `[2/5] Counting remote files... (${elapsed(t0)})`, increment: 2 });
        let remoteFileCount = 0;
        const srcAG = path.join(syncDir, 'antigravity');
        if (fs.existsSync(srcAG)) {
            remoteFileCount = countFiles(srcAG);
        }
        progress?.report({ message: `[2/5] ${remoteFileCount.toLocaleString()} files found in remote. (${elapsed(t0)})`, increment: 3 });

        // Phase 3: Merge
        let filesImported = 0;
        let filesSkipped = 0;

        if (fs.existsSync(srcAG)) {
            const entries = fs.readdirSync(srcAG, { withFileTypes: true });
            const totalEntries = entries.length;
            let entryIdx = 0;

            for (const entry of entries) {
                entryIdx++;
                const catId = identifyCategory(entry.name);
                if (catId && categorySelections && categorySelections[catId] === false) {
                    filesSkipped++;
                    progress?.report({ message: `[3/5] Skipped ${entry.name} (excluded). (${elapsed(t0)})` });
                    continue;
                }

                const srcPath = path.join(srcAG, entry.name);
                const dstPath = path.join(scanner.AG_ROOT, entry.name);

                progress?.report({
                    message: `[3/5] Importing ${entry.name} (${entryIdx}/${totalEntries}, mode: ${conflictMode})... (${elapsed(t0)})`,
                    increment: Math.floor(50 / totalEntries)
                });

                if (entry.isDirectory()) {
                    const result = mergeDirRecursive(srcPath, dstPath, conflictMode);
                    filesImported += result.imported;
                    filesSkipped += result.skipped;
                    progress?.report({
                        message: `[3/5] ${entry.name}: ${result.imported} imported, ${result.skipped} skipped. (${elapsed(t0)})`
                    });
                } else {
                    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                    fs.copyFileSync(srcPath, dstPath);
                    filesImported++;
                }
            }
        }

        // Merge gemini-root
        const srcGR = path.join(syncDir, 'gemini-root');
        if (fs.existsSync(srcGR)) {
            for (const file of fs.readdirSync(srcGR)) {
                const srcPath = path.join(srcGR, file);
                const dstPath = path.join(scanner.GEMINI_ROOT, file);
                if (fs.statSync(srcPath).isFile()) { fs.copyFileSync(srcPath, dstPath); filesImported++; }
            }
        }

        // Phase 4: Finalize
        progress?.report({ message: `[4/5] Finalizing... (${elapsed(t0)})`, increment: 5 });

        let commitSha = null;
        try { commitSha = shell('git rev-parse HEAD', { cwd: syncDir }).trim(); } catch (e) { }

        state.lastPullTime = new Date().toISOString();
        state.lastPullCommit = commitSha;

        syncState.addHistoryEntry(state, { action: 'pull', commit: commitSha, filesImported, filesSkipped });

        // Phase 5: Done
        const totalTime = elapsed(t0);
        progress?.report({ message: `Done! ${filesImported.toLocaleString()} imported, ${filesSkipped} skipped in ${totalTime}`, increment: 5 });

        return { success: true, filesImported, filesSkipped, commit: commitSha };

    } finally {
        safeCleanup(syncDir);
    }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function identifyCategory(name) {
    const map = {
        'conversations': 'chats', 'conversations_backup': 'chats', 'conversations_full': 'chats',
        'brain': 'brain', 'knowledge': 'knowledge', 'scratch': 'scratch',
        'browser_recordings': 'recordings', 'annotations': 'annotations',
        'implicit': 'annotations', 'context_state': 'annotations',
        'prompting': 'prompting', 'html_artifacts': 'html_artifacts',
        'code_tracker': 'code_tracker', 'playground': 'playground', 'daemon': 'daemon'
    };
    return map[name] || null;
}

function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, entry.name), d = path.join(dst, entry.name);
            try { entry.isDirectory() ? copyDirRecursive(s, d) : fs.copyFileSync(s, d); } catch (e) { }
        }
    } catch (e) { }
}

function mergeDirRecursive(src, dst, mode) {
    const result = { imported: 0, skipped: 0 };
    fs.mkdirSync(dst, { recursive: true });
    try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, entry.name), d = path.join(dst, entry.name);
            if (entry.isDirectory()) {
                const sub = mergeDirRecursive(s, d, mode);
                result.imported += sub.imported; result.skipped += sub.skipped;
            } else {
                mergeFile(s, d, mode) ? result.imported++ : result.skipped++;
            }
        }
    } catch (e) { }
    return result;
}

function mergeFile(src, dst, mode) {
    try {
        if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); return true; }
        if (mode === 'skip') return false;
        if (mode === 'newer-wins' && fs.statSync(src).mtimeMs <= fs.statSync(dst).mtimeMs) return false;
        fs.copyFileSync(src, dst); return true;
    } catch (e) { return false; }
}

function countFiles(dir) {
    let count = 0;
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) count += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1; } catch (e) { }
    return count;
}

module.exports = { storeToken, getToken, deleteToken, isGhCliAvailable, getGhUsername, createSyncRepo, listSyncRepos, ensureRepo, pushToGithub, pullFromGithub };
