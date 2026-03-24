const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const scanner = require('./scanner');
const syncState = require('./syncState');

// Persistent git dir — lives inside AG data, persists between pushes for incremental sync
const PERSISTENT_GIT_DIR = path.join(scanner.AG_ROOT, '.ag-sync-repo');
// Temp dir only used for pull (needs to clone from remote)
const PULL_TMP_BASE = path.join(os.tmpdir(), 'ag-sync-pull');

// ── Shell helper — ALL commands go through cmd /c ────────────────────────────
function shell(command, opts = {}) {
    const defaults = { encoding: 'utf8', windowsHide: true, timeout: 15000 };
    return execSync(`cmd /c ${command}`, { ...defaults, ...opts });
}

// Git command helper — uses GIT_DIR + GIT_WORK_TREE so git reads files in-place
function gitCmd(command, extraOpts = {}) {
    const env = {
        ...process.env,
        GIT_DIR: PERSISTENT_GIT_DIR,
        GIT_WORK_TREE: scanner.AG_ROOT
    };
    const defaults = { encoding: 'utf8', windowsHide: true, timeout: 120000, env };
    return execSync(`cmd /c git ${command}`, { ...defaults, ...extraOpts });
}

// Initialize or verify the persistent git repo
function ensurePersistentRepo(repoUrl) {
    if (!fs.existsSync(PERSISTENT_GIT_DIR)) {
        fs.mkdirSync(PERSISTENT_GIT_DIR, { recursive: true });
        gitCmd('init --bare');
        gitCmd(`remote add origin "${repoUrl}"`);
    } else {
        // Ensure remote is correct
        try {
            const current = gitCmd('remote get-url origin').trim();
            if (current !== repoUrl) {
                gitCmd(`remote set-url origin "${repoUrl}"`);
            }
        } catch (e) {
            try { gitCmd(`remote add origin "${repoUrl}"`); } catch (e2) { }
        }
    }
}

// Safe cleanup with retry for Windows file locks
function safeCleanup(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            if (attempt < 2) {
                try { execSync('cmd /c timeout /t 1 /nobreak >nul 2>&1', { windowsHide: true, timeout: 3000 }); } catch (e2) { }
            }
        }
    }
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

// ── Only skip .git dirs (would conflict with sync repo's own git) ────────────
function shouldSkip(name) {
    return name === '.git';
}

// ── Tracked copy: reports progress every N files ────────────────────────────
function copyDirTracked(src, dst, tracker) {
    fs.mkdirSync(dst, { recursive: true });
    try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            if (shouldSkip(entry.name)) continue;
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
    progress?.report({ message: `[0/4] Checking repo config... (${elapsed(t0)})`, increment: 2 });
    ensureRepo(state);
    progress?.report({ message: `[0/4] Repo: ${state.githubRepo} (${elapsed(t0)})`, increment: 3 });

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    // Phase 1: Ensure persistent git repo
    progress?.report({ message: `[1/4] Setting up persistent repo... (${elapsed(t0)})`, increment: 5 });
    ensurePersistentRepo(repoUrl);
    progress?.report({ message: `[1/4] Repo ready. (${elapsed(t0)})`, increment: 5 });

    const selectedCats = Object.keys(categorySelections).filter(id => categorySelections[id]);

    // Phase 2: Stage selected files (git reads directly from source — no copies)
    progress?.report({ message: `[2/4] Staging files... (${elapsed(t0)})`, increment: 5 });

    // Reset index to start fresh staging
    try { gitCmd('rm -r --cached . 2>&1', { timeout: 300000 }); } catch (e) { }

    for (const catId of selectedCats) {
        const catDef = scanner.CATEGORIES[catId];
        if (!catDef) continue;
        progress?.report({ message: `[2/4] Adding ${catDef.label}... (${elapsed(t0)})` });

        for (const dir of (catDef.dirs || [])) {
            const dirPath = path.join(scanner.AG_ROOT, dir);
            if (fs.existsSync(dirPath)) {
                try { gitCmd(`add -f -- "${dir}"`, { timeout: 300000 }); } catch (e) { }
            }
        }
        for (const file of (catDef.files || [])) {
            const filePath = path.join(scanner.AG_ROOT, file);
            if (fs.existsSync(filePath)) {
                try { gitCmd(`add -f -- "${file}"`, { timeout: 30000 }); } catch (e) { }
            }
        }
    }
    progress?.report({ message: `[2/4] Files staged. (${elapsed(t0)})`, increment: 10 });

    // Check for changes
    let hasChanges = true;
    try {
        const status = gitCmd('status --porcelain').trim();
        if (!status) hasChanges = false;
    } catch (e) { }

    if (!hasChanges) {
        progress?.report({ message: `[2/4] No changes detected. (${elapsed(t0)})`, increment: 50 });
        return { success: true, message: 'No changes to push.', filesCount: 0 };
    }

    // Commit
    const commitMsg = `AG Sync: ${new Date().toISOString()} from ${os.hostname()}`;
    progress?.report({ message: `[2/4] Committing... (${elapsed(t0)})`, increment: 5 });
    try {
        gitCmd(`commit -m "${commitMsg}"`, { timeout: 300000 });
    } catch (e) {
        const msg = [e.stdout, e.stderr].filter(Boolean).join(' ');
        if (msg.includes('nothing to commit')) return { success: true, message: 'Already up to date.', filesCount: 0 };
        throw e;
    }

    // Count committed files
    let totalFiles = 0;
    try {
        const ls = gitCmd('diff --name-only HEAD~1..HEAD 2>&1').trim();
        totalFiles = ls ? ls.split('\n').length : 0;
    } catch (e) {
        try {
            const ls = gitCmd('ls-tree -r --name-only HEAD').trim();
            totalFiles = ls ? ls.split('\n').length : 0;
        } catch (e2) { }
    }

    // Phase 3: Push
    progress?.report({ message: `[3/4] Pushing ${totalFiles.toLocaleString()} files to GitHub... (${elapsed(t0)})`, increment: 10 });
    try {
        gitCmd('push -u origin main --force 2>&1', { timeout: 600000 });
    } catch (e) {
        try {
            gitCmd('push --set-upstream origin main --force 2>&1', { timeout: 600000 });
        } catch (e2) {
            throw new Error(`Push failed: ${e2.message}`);
        }
    }
    progress?.report({ message: `[3/4] Push complete. (${elapsed(t0)})`, increment: 10 });

    let commitSha = null;
    try { commitSha = gitCmd('rev-parse HEAD').trim(); } catch (e) { }

    // Phase 4: Finalize
    progress?.report({ message: `[4/4] Finalizing... (${elapsed(t0)})`, increment: 2 });

    state.lastPushTime = new Date().toISOString();
    state.lastPushCommit = commitSha;
    state.categorySelections = categorySelections;

    const { currentHashes } = syncState.detectChanges(state, categorySelections);
    syncState.updateSyncHashes(state, currentHashes);

    syncState.addHistoryEntry(state, {
        action: 'push', commit: commitSha, filesCount: totalFiles, categories: selectedCats
    });

    const totalTime = elapsed(t0);
    progress?.report({ message: `Done! ${totalFiles.toLocaleString()} files pushed in ${totalTime}`, increment: 5 });

    return { success: true, message: `Pushed ${totalFiles.toLocaleString()} files in ${totalTime}.`, filesCount: totalFiles, commit: commitSha };
}

async function pullFromGithub(state, categorySelections, conflictMode, progress) {
    const t0 = Date.now();

    // Phase 0: Ensure repo
    progress?.report({ message: `[0/4] Checking repo config... (${elapsed(t0)})`, increment: 2 });
    ensureRepo(state);
    progress?.report({ message: `[0/4] Repo: ${state.githubRepo} (${elapsed(t0)})`, increment: 3 });

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    // Create temp dir for clone (pull does need to download)
    const pullDir = path.join(PULL_TMP_BASE, `pull-${Date.now()}`);
    fs.mkdirSync(pullDir, { recursive: true });

    try {
        // Phase 1: Clone
        progress?.report({ message: `[1/4] Cloning from GitHub... (${elapsed(t0)})`, increment: 5 });
        try {
            shell(`git clone --depth 1 "${repoUrl}" "${pullDir}" 2>&1`, { timeout: 600000 });
        } catch (e) {
            throw new Error(`Clone failed: ${e.message}`);
        }
        progress?.report({ message: `[1/4] Clone complete. (${elapsed(t0)})`, increment: 10 });

        // Phase 2: Merge files into AG data directory
        let filesImported = 0;
        let filesSkipped = 0;

        // The cloned repo has files at top level (same paths as AG_ROOT)
        const entries = fs.readdirSync(pullDir, { withFileTypes: true })
            .filter(e => e.name !== '.git' && e.name !== '_ag_sync_meta.json');
        const totalEntries = entries.length;
        let entryIdx = 0;

        for (const entry of entries) {
            entryIdx++;
            const catId = identifyCategory(entry.name);
            if (catId && categorySelections && categorySelections[catId] === false) {
                filesSkipped++;
                progress?.report({ message: `[2/4] Skipped ${entry.name} (excluded). (${elapsed(t0)})` });
                continue;
            }

            const srcPath = path.join(pullDir, entry.name);
            const dstPath = path.join(scanner.AG_ROOT, entry.name);

            progress?.report({
                message: `[2/4] Importing ${entry.name} (${entryIdx}/${totalEntries})... (${elapsed(t0)})`,
                increment: Math.floor(50 / Math.max(totalEntries, 1))
            });

            if (entry.isDirectory()) {
                const result = mergeDirRecursive(srcPath, dstPath, conflictMode);
                filesImported += result.imported;
                filesSkipped += result.skipped;
                progress?.report({
                    message: `[2/4] ${entry.name}: ${result.imported} imported, ${result.skipped} skipped. (${elapsed(t0)})`
                });
            } else {
                fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                fs.copyFileSync(srcPath, dstPath);
                filesImported++;
            }
        }

        // Phase 3: Finalize
        progress?.report({ message: `[3/4] Finalizing... (${elapsed(t0)})`, increment: 5 });

        let commitSha = null;
        try { commitSha = shell('git rev-parse HEAD', { cwd: pullDir }).trim(); } catch (e) { }

        state.lastPullTime = new Date().toISOString();
        state.lastPullCommit = commitSha;

        syncState.addHistoryEntry(state, { action: 'pull', commit: commitSha, filesImported, filesSkipped });

        // Phase 4: Done
        const totalTime = elapsed(t0);
        progress?.report({ message: `Done! ${filesImported.toLocaleString()} imported, ${filesSkipped} skipped in ${totalTime}`, increment: 5 });

        return { success: true, filesImported, filesSkipped, commit: commitSha };

    } finally {
        safeCleanup(pullDir);
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
            if (shouldSkip(entry.name)) continue;
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
            if (shouldSkip(entry.name)) continue;
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
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (shouldSkip(e.name)) continue;
            count += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
        }
    } catch (e) { }
    return count;
}

module.exports = { storeToken, getToken, deleteToken, isGhCliAvailable, getGhUsername, createSyncRepo, listSyncRepos, ensureRepo, pushToGithub, pullFromGithub };
