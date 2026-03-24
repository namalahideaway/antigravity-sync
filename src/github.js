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

const SYNC_DIR = path.join(os.tmpdir(), 'ag-sync-git');
const GITIGNORE_CONTENT = `
# AG Sync gitignore
node_modules/
*.vsix
.DS_Store
Thumbs.db
*.log
`.trim();

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

function prepareLocalRepo(repoUrl) {
    if (fs.existsSync(SYNC_DIR)) {
        fs.rmSync(SYNC_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SYNC_DIR, { recursive: true });

    try {
        shell(`git clone "${repoUrl}" "${SYNC_DIR}" 2>&1`, { timeout: 120000 });
        return true;
    } catch (e) {
        // Init fresh repo if clone fails (empty repo)
        shell('git init', { cwd: SYNC_DIR });
        shell(`git remote add origin "${repoUrl}"`, { cwd: SYNC_DIR });
        try { shell('git checkout -b main', { cwd: SYNC_DIR }); } catch (e2) { }
        return true;
    }
}

async function pushToGithub(state, categorySelections, progress) {
    // Auto-create repo if none configured
    progress?.report({ message: 'Checking repo...', increment: 2 });
    ensureRepo(state);

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    progress?.report({ message: 'Preparing local repo...', increment: 5 });
    prepareLocalRepo(repoUrl);

    progress?.report({ message: 'Copying data to staging...', increment: 5 });

    const stagingAG = path.join(SYNC_DIR, 'antigravity');
    const stagingGR = path.join(SYNC_DIR, 'gemini-root');
    fs.mkdirSync(stagingAG, { recursive: true });
    fs.mkdirSync(stagingGR, { recursive: true });

    fs.writeFileSync(path.join(SYNC_DIR, '.gitignore'), GITIGNORE_CONTENT, 'utf8');

    const selectedCats = Object.keys(categorySelections).filter(id => categorySelections[id]);
    let totalFiles = 0;

    for (const catId of selectedCats) {
        const catDef = scanner.CATEGORIES[catId];
        if (!catDef) continue;

        progress?.report({ message: `Staging ${catDef.label}...` });

        for (const dir of (catDef.dirs || [])) {
            const srcPath = path.join(scanner.AG_ROOT, dir);
            const dstPath = path.join(stagingAG, dir);
            if (fs.existsSync(srcPath)) {
                copyDirRecursive(srcPath, dstPath);
                totalFiles += countFiles(dstPath);
            }
        }

        for (const file of (catDef.files || [])) {
            const srcPath = path.join(scanner.AG_ROOT, file);
            if (fs.existsSync(srcPath)) {
                const dstPath = path.join(stagingAG, file);
                fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                fs.copyFileSync(srcPath, dstPath);
                totalFiles++;
            }
        }

        for (const file of (catDef.parentFiles || [])) {
            const srcPath = path.join(scanner.GEMINI_ROOT, file);
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, path.join(stagingGR, file));
                totalFiles++;
            }
        }
    }

    // Sync metadata
    const syncMeta = {
        lastPush: new Date().toISOString(),
        machine: state.machineId,
        hostname: os.hostname(),
        categories: selectedCats,
        fileCount: totalFiles
    };
    fs.writeFileSync(path.join(SYNC_DIR, '_ag_sync_meta.json'), JSON.stringify(syncMeta, null, 2), 'utf8');

    // Git operations
    progress?.report({ message: 'Committing changes...', increment: 20 });
    const gitOpts = { cwd: SYNC_DIR, timeout: 300000 };

    shell('git add -A', gitOpts);

    try {
        const status = shell('git status --porcelain', gitOpts).trim();
        if (!status) return { success: true, message: 'No changes to push.', filesCount: 0 };
    } catch (e) { }

    const commitMsg = `AG Sync: ${new Date().toISOString()} from ${os.hostname()} (${totalFiles} files)`;
    try {
        shell(`git commit -m "${commitMsg}"`, gitOpts);
    } catch (e) {
        const msg = [e.stdout, e.stderr].filter(Boolean).join(' ');
        if (msg.includes('nothing to commit')) return { success: true, message: 'Already up to date.', filesCount: 0 };
        throw e;
    }

    progress?.report({ message: 'Pushing to GitHub...', increment: 30 });
    try {
        shell('git push -u origin main --force 2>&1', gitOpts);
    } catch (e) {
        try {
            shell('git push --set-upstream origin main --force 2>&1', gitOpts);
        } catch (e2) {
            throw new Error(`Push failed: ${e2.message}`);
        }
    }

    let commitSha = null;
    try { commitSha = shell('git rev-parse HEAD', gitOpts).trim(); } catch (e) { }

    state.lastPushTime = new Date().toISOString();
    state.lastPushCommit = commitSha;
    state.categorySelections = categorySelections;

    const { currentHashes } = syncState.detectChanges(state, categorySelections);
    syncState.updateSyncHashes(state, currentHashes);

    syncState.addHistoryEntry(state, {
        action: 'push', commit: commitSha, filesCount: totalFiles, categories: selectedCats
    });

    try { fs.rmSync(SYNC_DIR, { recursive: true, force: true }); } catch (e) { }

    return { success: true, message: `Pushed ${totalFiles} files.`, filesCount: totalFiles, commit: commitSha };
}

async function pullFromGithub(state, categorySelections, conflictMode, progress) {
    // Auto-create repo if none configured
    progress?.report({ message: 'Checking repo...', increment: 2 });
    ensureRepo(state);

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    progress?.report({ message: 'Cloning from GitHub...', increment: 10 });

    if (fs.existsSync(SYNC_DIR)) fs.rmSync(SYNC_DIR, { recursive: true, force: true });

    try {
        shell(`git clone "${repoUrl}" "${SYNC_DIR}" 2>&1`, { timeout: 300000 });
    } catch (e) {
        throw new Error(`Clone failed: ${e.message}`);
    }

    progress?.report({ message: 'Merging data...', increment: 10 });

    let filesImported = 0;
    let filesSkipped = 0;

    const srcAG = path.join(SYNC_DIR, 'antigravity');
    if (fs.existsSync(srcAG)) {
        const entries = fs.readdirSync(srcAG, { withFileTypes: true });
        for (const entry of entries) {
            const catId = identifyCategory(entry.name);
            if (catId && categorySelections && categorySelections[catId] === false) { filesSkipped++; continue; }

            const srcPath = path.join(srcAG, entry.name);
            const dstPath = path.join(scanner.AG_ROOT, entry.name);

            progress?.report({ message: `Importing ${entry.name}...` });

            if (entry.isDirectory()) {
                const result = mergeDirRecursive(srcPath, dstPath, conflictMode);
                filesImported += result.imported;
                filesSkipped += result.skipped;
            } else {
                fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                fs.copyFileSync(srcPath, dstPath);
                filesImported++;
            }
        }
    }

    const srcGR = path.join(SYNC_DIR, 'gemini-root');
    if (fs.existsSync(srcGR)) {
        for (const file of fs.readdirSync(srcGR)) {
            const srcPath = path.join(srcGR, file);
            const dstPath = path.join(scanner.GEMINI_ROOT, file);
            if (fs.statSync(srcPath).isFile()) { fs.copyFileSync(srcPath, dstPath); filesImported++; }
        }
    }

    let commitSha = null;
    try { commitSha = shell('git rev-parse HEAD', { cwd: SYNC_DIR }).trim(); } catch (e) { }

    state.lastPullTime = new Date().toISOString();
    state.lastPullCommit = commitSha;

    syncState.addHistoryEntry(state, { action: 'pull', commit: commitSha, filesImported, filesSkipped });

    try { fs.rmSync(SYNC_DIR, { recursive: true, force: true }); } catch (e) { }

    return { success: true, filesImported, filesSkipped, commit: commitSha };
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
