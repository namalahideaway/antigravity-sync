// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Sync State Tracker
// Tracks sync state, detects changes, and manages sync history
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scanner = require('./scanner');

const STATE_FILE = path.join(scanner.AG_ROOT, '.ag-sync-state.json');

/**
 * Default sync state
 */
function defaultState() {
    return {
        version: '1.0',
        githubRepo: null,          // 'owner/repo'
        lastPushTime: null,
        lastPullTime: null,
        lastPushCommit: null,
        lastPullCommit: null,
        syncedFileHashes: {},      // { relativePath: sha256 }
        categorySelections: null,  // { catId: bool }
        syncHistory: [],           // Last 50 sync events
        machineId: generateMachineId()
    };
}

/**
 * Load sync state from disk
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            return { ...defaultState(), ...JSON.parse(raw) };
        }
    } catch (e) { /* corrupted state, start fresh */ }
    return defaultState();
}

/**
 * Save sync state to disk
 */
function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save sync state:', e.message);
    }
}

/**
 * Add an entry to sync history
 */
function addHistoryEntry(state, entry) {
    state.syncHistory.unshift({
        timestamp: new Date().toISOString(),
        ...entry
    });
    // Keep last 50 entries
    if (state.syncHistory.length > 50) {
        state.syncHistory = state.syncHistory.slice(0, 50);
    }
    saveState(state);
}

/**
 * Detect files that have changed since last sync
 * Returns { added: [], modified: [], deleted: [], unchanged: [] }
 */
function detectChanges(state, categories) {
    const changes = { added: [], modified: [], deleted: [], unchanged: [] };
    const currentHashes = {};

    // Scan currently selected categories
    for (const catId of Object.keys(categories)) {
        const catScan = scanner.scanCategory(catId);
        if (!catScan) continue;

        for (const file of catScan.files) {
            const hash = quickHash(file.path, file.size, file.mtime);
            currentHashes[file.relativePath] = hash;

            const prevHash = state.syncedFileHashes[file.relativePath];
            if (!prevHash) {
                changes.added.push(file.relativePath);
            } else if (prevHash !== hash) {
                changes.modified.push(file.relativePath);
            } else {
                changes.unchanged.push(file.relativePath);
            }
        }
    }

    // Find deleted files
    for (const relPath of Object.keys(state.syncedFileHashes)) {
        if (!currentHashes[relPath]) {
            changes.deleted.push(relPath);
        }
    }

    return { changes, currentHashes };
}

/**
 * Quick hash based on size + mtime (fast, good enough for change detection)
 */
function quickHash(filePath, size, mtime) {
    return crypto.createHash('md5')
        .update(`${size}:${Math.floor(mtime)}`)
        .digest('hex');
}

/**
 * Full SHA-256 hash of file content (for conflict resolution)
 */
function fullHash(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (e) {
        return null;
    }
}

/**
 * Update sync state hashes after a successful sync
 */
function updateSyncHashes(state, currentHashes) {
    state.syncedFileHashes = { ...currentHashes };
    saveState(state);
}

/**
 * Reset sync state
 */
function resetState() {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
}

/**
 * Generate a machine-unique ID
 */
function generateMachineId() {
    const os = require('os');
    const raw = `${os.hostname()}-${os.userInfo().username}-${os.platform()}`;
    return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

module.exports = {
    loadState,
    saveState,
    addHistoryEntry,
    detectChanges,
    updateSyncHashes,
    resetState,
    fullHash,
    STATE_FILE
};
