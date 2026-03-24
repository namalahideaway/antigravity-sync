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

// ── Stale lockfile cleanup ──────────────────────────────────────────────────
function clearStaleLocks() {
    const lockFile = path.join(PERSISTENT_GIT_DIR, 'index.lock');
    if (fs.existsSync(lockFile)) {
        try {
            fs.unlinkSync(lockFile);
            console.log('[AG Sync] Removed stale index.lock');
        } catch (e) {
            console.warn('[AG Sync] Could not remove index.lock:', e.message);
        }
    }
}

// Initialize or verify the persistent git repo
function ensurePersistentRepo(repoUrl) {
    const headPath = path.join(PERSISTENT_GIT_DIR, 'HEAD');

    if (!fs.existsSync(headPath)) {
        // Directory might exist but be corrupt (no HEAD) — wipe and reinit
        if (fs.existsSync(PERSISTENT_GIT_DIR)) {
            try { fs.rmSync(PERSISTENT_GIT_DIR, { recursive: true, force: true }); } catch (e) { }
        }
        fs.mkdirSync(PERSISTENT_GIT_DIR, { recursive: true });

        // Init WITHOUT --bare
        const initEnv = { ...process.env, GIT_DIR: PERSISTENT_GIT_DIR };
        execSync(`cmd /c git init`, {
            encoding: 'utf8', windowsHide: true, timeout: 30000, env: initEnv
        });

        gitCmd('config core.bare false');
        gitCmd(`remote add origin "${repoUrl}"`);
        console.log(`[AG Sync] Initialized persistent repo at ${PERSISTENT_GIT_DIR}`);
    } else {
        // Existing valid repo — ensure bare is off and remote is correct
        try { gitCmd('config core.bare false'); } catch (e) { }
        try {
            const current = gitCmd('remote get-url origin').trim();
            if (current !== repoUrl) {
                gitCmd(`remote set-url origin "${repoUrl}"`);
            }
        } catch (e) {
            try { gitCmd(`remote add origin "${repoUrl}"`); } catch (e2) { }
        }
    }

    // Always clear stale locks after init/verify
    clearStaleLocks();
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
        try {
            if (e.stdout && e.stdout.includes('Logged in')) return true;
            if (e.stderr && e.stderr.includes('Logged in')) return true;
            if (e.output) {
                const combined = e.output.map(b => b ? b.toString() : '').join('');
                if (combined.includes('Logged in')) return true;
            }
        } catch (e2) { }
        return false;
    }
}

function getGhUsername() {
    try {
        const result = shell('gh auth status 2>&1', { timeout: 8000 });
        const match = result.match(/account\s+(\S+)/);
        return match ? match[1] : null;
    } catch (e) {
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
 */
function ensureRepo(state) {
    if (state.githubRepo) return state.githubRepo;

    if (!isGhCliAvailable()) {
        throw new Error('GitHub CLI not authenticated. Run: gh auth login');
    }

    const user = getGhUsername();
    if (!user) throw new Error('Could not determine GitHub username.');

    const repoName = `${user}/antigravity-sync-data`;

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

    state.githubRepo = repoName;
    syncState.saveState(state);
    console.log(`[AG Sync] Auto-created private repo: ${repoName}`);
    return repoName;
}

// ── Elapsed time + ETA helpers ──────────────────────────────────────────────

function elapsed(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function eta(startMs, done, total) {
    if (done <= 0 || total <= 0) return '';
    const elapsedMs = Date.now() - startMs;
    const rate = done / elapsedMs;
    const remainMs = (total - done) / rate;
    const s = Math.ceil(remainMs / 1000);
    if (s < 60) return `~${s}s left`;
    return `~${Math.floor(s / 60)}m ${s % 60}s left`;
}

function pct(done, total) {
    if (total <= 0) return '0%';
    return Math.min(100, Math.round((done / total) * 100)) + '%';
}

// ── Only skip .git dirs ─────────────────────────────────────────────────────
function shouldSkip(name) {
    return name === '.git';
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

// ═════════════════════════════════════════════════════════════════════════════
// PUSH v2.0 — Checksum-based selective staging with real % progress
// ═════════════════════════════════════════════════════════════════════════════

async function pushToGithub(state, categorySelections, progress) {
    const t0 = Date.now();

    // ── Phase 0: Ensure repo config ──────────────────────────────────────
    progress?.report({ message: `[1/5] Checking repo config...`, increment: 2 });
    ensureRepo(state);
    progress?.report({ message: `[1/5] Repo: ${state.githubRepo}`, increment: 3 });

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    // ── Phase 1: Setup persistent git repo + clear stale locks ───────────
    progress?.report({ message: `[1/5] Setting up git repo...`, increment: 2 });
    ensurePersistentRepo(repoUrl);
    progress?.report({ message: `[1/5] Git repo ready (${elapsed(t0)})`, increment: 3 });

    // ── Phase 2: Checksum scan — detect what actually changed ────────────
    progress?.report({ message: `[2/5] Scanning files for changes...`, increment: 2 });

    const scanResult = syncState.detectChangedFiles(state, categorySelections, (scanned, total, currentFile) => {
        progress?.report({
            message: `[2/5] Scanning: ${scanned.toLocaleString()}/${total.toLocaleString()} (${pct(scanned, total)}) ${eta(t0, scanned, total)}`
        });
    });

    const { toAdd, toUpdate, toRemove, unchanged, currentHashes, totalFiles, changedCount } = scanResult;

    progress?.report({
        message: `[2/5] Scan done: ${changedCount.toLocaleString()} changed, ${unchanged.length.toLocaleString()} unchanged (${elapsed(t0)})`,
        increment: 8
    });

    // If nothing changed, skip everything
    if (changedCount === 0) {
        progress?.report({ message: `No changes detected. All ${totalFiles.toLocaleString()} files match checksums.`, increment: 80 });
        return { success: true, message: `No changes to push. ${totalFiles.toLocaleString()} files verified.`, filesCount: 0 };
    }

    // ── Phase 3: Selective staging — only add changed/new, rm deleted ────
    const filesToStage = [...toAdd, ...toUpdate];
    const totalStages = filesToStage.length + toRemove.length;
    let staged = 0;

    progress?.report({
        message: `[3/5] Staging ${totalStages.toLocaleString()} changed files...`,
        increment: 2
    });

    // Clear stale locks before staging
    clearStaleLocks();

    // Stage changed/new files in batches (git add up to 50 paths at a time)
    const BATCH_SIZE = 50;
    for (let i = 0; i < filesToStage.length; i += BATCH_SIZE) {
        const batch = filesToStage.slice(i, i + BATCH_SIZE);
        const quotedPaths = batch.map(p => `"${p}"`).join(' ');
        try {
            gitCmd(`add -f -- ${quotedPaths}`, { timeout: 300000 });
        } catch (e) {
            // Fallback: add one by one
            for (const p of batch) {
                try { gitCmd(`add -f -- "${p}"`, { timeout: 30000 }); } catch (e2) {
                    console.warn(`[AG Sync] git add failed for ${p}: ${e2.message}`);
                }
            }
        }
        staged += batch.length;
        if (staged % BATCH_SIZE === 0 || staged === filesToStage.length) {
            progress?.report({
                message: `[3/5] Staging: ${staged.toLocaleString()}/${totalStages.toLocaleString()} (${pct(staged, totalStages)}) ${eta(t0, staged, totalStages)}`
            });
        }
    }

    // Remove deleted files
    if (toRemove.length > 0) {
        for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
            const batch = toRemove.slice(i, i + BATCH_SIZE);
            const quotedPaths = batch.map(p => `"${p}"`).join(' ');
            try { gitCmd(`rm --cached --ignore-unmatch -- ${quotedPaths}`, { timeout: 60000 }); } catch (e) { }
            staged += batch.length;
        }
        progress?.report({
            message: `[3/5] Removed ${toRemove.length.toLocaleString()} deleted files from index`
        });
    }

    progress?.report({
        message: `[3/5] Staged: +${toAdd.length.toLocaleString()} new, ~${toUpdate.length.toLocaleString()} modified, -${toRemove.length.toLocaleString()} deleted (${elapsed(t0)})`,
        increment: 10
    });

    // ── Commit ───────────────────────────────────────────────────────────
    const commitMsg = `AG Sync: ${new Date().toISOString()} from ${os.hostname()} [+${toAdd.length} ~${toUpdate.length} -${toRemove.length}]`;
    progress?.report({ message: `[3/5] Committing ${changedCount.toLocaleString()} changes...`, increment: 5 });

    // Clear locks before commit too
    clearStaleLocks();

    try {
        gitCmd(`commit -m "${commitMsg}"`, { timeout: 300000 });
    } catch (e) {
        const msg = [e.stdout, e.stderr].filter(Boolean).join(' ');
        if (msg.includes('nothing to commit')) {
            return { success: true, message: 'Already up to date (git sees no diff).', filesCount: 0 };
        }
        // If index.lock error, try clearing and retrying once
        if (msg.includes('index.lock')) {
            clearStaleLocks();
            try {
                gitCmd(`commit -m "${commitMsg}"`, { timeout: 300000 });
            } catch (e2) {
                throw new Error(`Commit failed after lock cleanup: ${e2.message}`);
            }
        } else {
            throw e;
        }
    }

    // ── Phase 4: Push ────────────────────────────────────────────────────
    progress?.report({
        message: `[4/5] Pushing ${changedCount.toLocaleString()} changes to GitHub... (${elapsed(t0)})`,
        increment: 10
    });
    try {
        gitCmd('push -u origin main --force 2>&1', { timeout: 600000 });
    } catch (e) {
        try {
            gitCmd('push --set-upstream origin main --force 2>&1', { timeout: 600000 });
        } catch (e2) {
            throw new Error(`Push failed: ${e2.message}`);
        }
    }
    progress?.report({ message: `[4/5] Push complete. (${elapsed(t0)})`, increment: 10 });

    let commitSha = null;
    try { commitSha = gitCmd('rev-parse HEAD').trim(); } catch (e) { }

    // ── Phase 5: Finalize — save checksums ───────────────────────────────
    progress?.report({ message: `[5/5] Saving checksums...`, increment: 2 });

    state.lastPushTime = new Date().toISOString();
    state.lastPushCommit = commitSha;
    state.categorySelections = categorySelections;

    // Store the checksums we computed during scan so next push can diff
    syncState.updateSyncHashes(state, currentHashes);

    const selectedCats = Object.keys(categorySelections).filter(id => categorySelections[id]);
    syncState.addHistoryEntry(state, {
        action: 'push',
        commit: commitSha,
        filesCount: changedCount,
        totalFiles,
        added: toAdd.length,
        modified: toUpdate.length,
        deleted: toRemove.length,
        unchanged: unchanged.length,
        categories: selectedCats
    });

    const totalTime = elapsed(t0);
    progress?.report({
        message: `✓ Done! +${toAdd.length} ~${toUpdate.length} -${toRemove.length} pushed (${unchanged.length.toLocaleString()} unchanged) in ${totalTime}`,
        increment: 5
    });

    return {
        success: true,
        message: `Pushed ${changedCount.toLocaleString()} changes in ${totalTime}. ${unchanged.length.toLocaleString()} files unchanged.`,
        filesCount: changedCount,
        totalFiles,
        added: toAdd.length,
        modified: toUpdate.length,
        deleted: toRemove.length,
        unchanged: unchanged.length,
        commit: commitSha
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// PULL — unchanged from v1.9 (pull still needs full clone)
// ═════════════════════════════════════════════════════════════════════════════

async function pullFromGithub(state, categorySelections, conflictMode, progress) {
    const t0 = Date.now();

    progress?.report({ message: `[0/4] Checking repo config... (${elapsed(t0)})`, increment: 2 });
    ensureRepo(state);
    progress?.report({ message: `[0/4] Repo: ${state.githubRepo} (${elapsed(t0)})`, increment: 3 });

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    const pullDir = path.join(PULL_TMP_BASE, `pull-${Date.now()}`);
    fs.mkdirSync(pullDir, { recursive: true });

    try {
        progress?.report({ message: `[1/4] Cloning from GitHub... (${elapsed(t0)})`, increment: 5 });
        try {
            shell(`git clone --depth 1 "${repoUrl}" "${pullDir}" 2>&1`, { timeout: 600000 });
        } catch (e) {
            throw new Error(`Clone failed: ${e.message}`);
        }
        progress?.report({ message: `[1/4] Clone complete. (${elapsed(t0)})`, increment: 10 });

        let filesImported = 0;
        let filesSkipped = 0;

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

        progress?.report({ message: `[3/4] Finalizing... (${elapsed(t0)})`, increment: 5 });

        let commitSha = null;
        try { commitSha = shell('git rev-parse HEAD', { cwd: pullDir }).trim(); } catch (e) { }

        state.lastPullTime = new Date().toISOString();
        state.lastPullCommit = commitSha;

        syncState.addHistoryEntry(state, { action: 'pull', commit: commitSha, filesImported, filesSkipped });

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
