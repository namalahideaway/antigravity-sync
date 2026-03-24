// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — GitHub Sync Backend
// Push/pull AG data to/from a private GitHub repository
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
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

/**
 * Store GitHub PAT in VS Code SecretStorage
 */
async function storeToken(context, token) {
    await context.secrets.store('agSync.githubToken', token);
}

/**
 * Get GitHub PAT from VS Code SecretStorage
 */
async function getToken(context) {
    return await context.secrets.get('agSync.githubToken');
}

/**
 * Delete stored token
 */
async function deleteToken(context) {
    await context.secrets.delete('agSync.githubToken');
}

/**
 * Check if gh CLI is available and authenticated
 */
function isGhCliAvailable() {
    try {
        const result = execSync('gh auth status 2>&1', {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000
        });
        return result.includes('Logged in');
    } catch (e) {
        return false;
    }
}

/**
 * Get the authenticated GitHub username
 */
function getGhUsername() {
    try {
        const result = execSync('gh auth status 2>&1', {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000
        });
        const match = result.match(/account\s+(\S+)/);
        return match ? match[1] : null;
    } catch (e) {
        return null;
    }
}

/**
 * Create a private GitHub repo for sync data
 */
async function createSyncRepo(repoName) {
    try {
        const result = execSync(
            `gh repo create ${repoName} --private --description "Antigravity Sync Data" 2>&1`,
            { encoding: 'utf8', windowsHide: true, timeout: 30000 }
        );
        return { success: true, url: result.trim() };
    } catch (e) {
        // Repo may already exist
        if (e.stderr && e.stderr.includes('already exists')) {
            return { success: true, url: `https://github.com/${repoName}`, existing: true };
        }
        return { success: false, error: e.message };
    }
}

/**
 * List user's repos that match the sync pattern
 */
function listSyncRepos() {
    try {
        const result = execSync(
            'gh repo list --json nameWithOwner,description,isPrivate --limit 50 2>&1',
            { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        );
        return JSON.parse(result);
    } catch (e) {
        return [];
    }
}

/**
 * Prepare local git staging area
 */
function prepareLocalRepo(repoUrl) {
    // Clean up any existing staging
    if (fs.existsSync(SYNC_DIR)) {
        fs.rmSync(SYNC_DIR, { recursive: true, force: true });
    }

    fs.mkdirSync(SYNC_DIR, { recursive: true });

    try {
        // Try to clone existing repo
        execSync(`git clone "${repoUrl}" "${SYNC_DIR}" 2>&1`, {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 120000
        });
        return true;
    } catch (e) {
        // Init fresh repo if clone fails (empty repo)
        execSync('git init', { cwd: SYNC_DIR, encoding: 'utf8', windowsHide: true });
        execSync(`git remote add origin "${repoUrl}"`, { cwd: SYNC_DIR, encoding: 'utf8', windowsHide: true });
        // Set default branch
        try {
            execSync('git checkout -b main', { cwd: SYNC_DIR, encoding: 'utf8', windowsHide: true });
        } catch (e) { /* already on main */ }
        return true;
    }
}

/**
 * Push selected categories to GitHub
 */
async function pushToGithub(state, categorySelections, progress) {
    if (!state.githubRepo) {
        throw new Error('No GitHub repo configured. Run "AG Sync: Select/Create Sync Repo" first.');
    }

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    progress?.report({ message: 'Preparing local repo...', increment: 5 });
    prepareLocalRepo(repoUrl);

    progress?.report({ message: 'Copying data to staging...', increment: 5 });

    const stagingAG = path.join(SYNC_DIR, 'antigravity');
    const stagingGR = path.join(SYNC_DIR, 'gemini-root');
    fs.mkdirSync(stagingAG, { recursive: true });
    fs.mkdirSync(stagingGR, { recursive: true });

    // Write .gitignore
    fs.writeFileSync(path.join(SYNC_DIR, '.gitignore'), GITIGNORE_CONTENT, 'utf8');

    // Copy selected categories
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

    // Write sync metadata
    const syncMeta = {
        lastPush: new Date().toISOString(),
        machine: state.machineId,
        hostname: os.hostname(),
        categories: selectedCats,
        fileCount: totalFiles
    };
    fs.writeFileSync(
        path.join(SYNC_DIR, '_ag_sync_meta.json'),
        JSON.stringify(syncMeta, null, 2),
        'utf8'
    );

    // Git add, commit, push
    progress?.report({ message: 'Committing changes...', increment: 20 });

    const gitOpts = { cwd: SYNC_DIR, encoding: 'utf8', windowsHide: true, timeout: 300000 };

    execSync('git add -A', gitOpts);

    // Check if there are changes to commit
    try {
        const status = execSync('git status --porcelain', gitOpts).trim();
        if (!status) {
            return { success: true, message: 'No changes to push.', filesCount: 0 };
        }
    } catch (e) { /* continue anyway */ }

    const commitMsg = `AG Sync: ${new Date().toISOString()} from ${os.hostname()} (${totalFiles} files)`;
    try {
        execSync(`git commit -m "${commitMsg}"`, gitOpts);
    } catch (e) {
        // If nothing to commit, that's fine
        if (e.message.includes('nothing to commit')) {
            return { success: true, message: 'Already up to date.', filesCount: 0 };
        }
        throw e;
    }

    progress?.report({ message: 'Pushing to GitHub...', increment: 30 });

    try {
        execSync('git push -u origin main --force', gitOpts);
    } catch (e) {
        // Try setting upstream on first push
        try {
            execSync('git push --set-upstream origin main --force', gitOpts);
        } catch (e2) {
            throw new Error(`Push failed: ${e2.message}`);
        }
    }

    // Get commit SHA
    let commitSha = null;
    try {
        commitSha = execSync('git rev-parse HEAD', gitOpts).trim();
    } catch (e) { /* ok */ }

    // Update state
    state.lastPushTime = new Date().toISOString();
    state.lastPushCommit = commitSha;
    state.categorySelections = categorySelections;

    // Update hashes
    const { currentHashes } = syncState.detectChanges(state, categorySelections);
    syncState.updateSyncHashes(state, currentHashes);

    syncState.addHistoryEntry(state, {
        action: 'push',
        commit: commitSha,
        filesCount: totalFiles,
        categories: selectedCats
    });

    // Cleanup
    try { fs.rmSync(SYNC_DIR, { recursive: true, force: true }); } catch (e) { }

    return { success: true, message: `Pushed ${totalFiles} files.`, filesCount: totalFiles, commit: commitSha };
}

/**
 * Pull from GitHub and merge into local AG data
 */
async function pullFromGithub(state, categorySelections, conflictMode, progress) {
    if (!state.githubRepo) {
        throw new Error('No GitHub repo configured.');
    }

    const repoUrl = `https://github.com/${state.githubRepo}.git`;

    progress?.report({ message: 'Cloning from GitHub...', increment: 10 });

    if (fs.existsSync(SYNC_DIR)) {
        fs.rmSync(SYNC_DIR, { recursive: true, force: true });
    }

    try {
        execSync(`git clone "${repoUrl}" "${SYNC_DIR}" 2>&1`, {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 300000
        });
    } catch (e) {
        throw new Error(`Clone failed: ${e.message}`);
    }

    progress?.report({ message: 'Merging data...', increment: 10 });

    let filesImported = 0;
    let filesSkipped = 0;

    // Merge antigravity directory
    const srcAG = path.join(SYNC_DIR, 'antigravity');
    if (fs.existsSync(srcAG)) {
        const entries = fs.readdirSync(srcAG, { withFileTypes: true });
        for (const entry of entries) {
            // Check category filter
            const catId = identifyCategory(entry.name);
            if (catId && categorySelections && categorySelections[catId] === false) {
                filesSkipped++;
                continue;
            }

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

    // Merge gemini-root
    const srcGR = path.join(SYNC_DIR, 'gemini-root');
    if (fs.existsSync(srcGR)) {
        const entries = fs.readdirSync(srcGR);
        for (const file of entries) {
            const srcPath = path.join(srcGR, file);
            const dstPath = path.join(scanner.GEMINI_ROOT, file);
            if (fs.statSync(srcPath).isFile()) {
                fs.copyFileSync(srcPath, dstPath);
                filesImported++;
            }
        }
    }

    // Get commit SHA
    let commitSha = null;
    try {
        commitSha = execSync('git rev-parse HEAD', { cwd: SYNC_DIR, encoding: 'utf8', windowsHide: true }).trim();
    } catch (e) { }

    // Update state
    state.lastPullTime = new Date().toISOString();
    state.lastPullCommit = commitSha;

    syncState.addHistoryEntry(state, {
        action: 'pull',
        commit: commitSha,
        filesImported,
        filesSkipped
    });

    // Cleanup
    try { fs.rmSync(SYNC_DIR, { recursive: true, force: true }); } catch (e) { }

    return { success: true, filesImported, filesSkipped, commit: commitSha };
}

// ── Utility functions ────────────────────────────────────────────────────────

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
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const s = path.join(src, entry.name);
            const d = path.join(dst, entry.name);
            try {
                if (entry.isDirectory()) copyDirRecursive(s, d);
                else fs.copyFileSync(s, d);
            } catch (e) { /* skip unreadable */ }
        }
    } catch (e) { }
}

function mergeDirRecursive(src, dst, conflictMode) {
    const result = { imported: 0, skipped: 0 };
    fs.mkdirSync(dst, { recursive: true });
    try {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const s = path.join(src, entry.name);
            const d = path.join(dst, entry.name);
            if (entry.isDirectory()) {
                const sub = mergeDirRecursive(s, d, conflictMode);
                result.imported += sub.imported;
                result.skipped += sub.skipped;
            } else {
                if (mergeFile(s, d, conflictMode)) result.imported++;
                else result.skipped++;
            }
        }
    } catch (e) { }
    return result;
}

function mergeFile(src, dst, mode) {
    try {
        if (!fs.existsSync(dst)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
            return true;
        }
        if (mode === 'skip') return false;
        if (mode === 'newer-wins') {
            if (fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
                fs.copyFileSync(src, dst);
                return true;
            }
            return false;
        }
        // default: overwrite
        fs.copyFileSync(src, dst);
        return true;
    } catch (e) {
        return false;
    }
}

function countFiles(dir) {
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) count += countFiles(path.join(dir, e.name));
            else count++;
        }
    } catch (e) { }
    return count;
}

module.exports = {
    storeToken,
    getToken,
    deleteToken,
    isGhCliAvailable,
    getGhUsername,
    createSyncRepo,
    listSyncRepos,
    pushToGithub,
    pullFromGithub
};
