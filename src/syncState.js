// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Sync State Tracker v2.0
// SHA-256 checksum-based change detection + progress callbacks
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scanner = require('./scanner');

const STATE_FILE = path.join(scanner.AG_ROOT, '.ag-sync-state.json');

// Files larger than this use size+mtime hash (too expensive to SHA-256)
const CONTENT_HASH_LIMIT = 50 * 1024 * 1024; // 50 MB

// ── Default state ────────────────────────────────────────────────────────────

function defaultState() {
    return {
        version: '2.0',
        githubRepo: null,
        lastPushTime: null,
        lastPullTime: null,
        lastPushCommit: null,
        lastPullCommit: null,
        syncedFileHashes: {},      // { relativePath: sha256_or_sizemtime }
        categorySelections: null,
        syncHistory: [],
        machineId: generateMachineId()
    };
}

// ── Load / Save ──────────────────────────────────────────────────────────────

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            return { ...defaultState(), ...JSON.parse(raw) };
        }
    } catch (e) { /* corrupted state, start fresh */ }
    return defaultState();
}

function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('[AG Sync] Failed to save sync state:', e.message);
    }
}

// ── History ──────────────────────────────────────────────────────────────────

function addHistoryEntry(state, entry) {
    state.syncHistory.unshift({
        timestamp: new Date().toISOString(),
        ...entry
    });
    if (state.syncHistory.length > 50) {
        state.syncHistory = state.syncHistory.slice(0, 50);
    }
    saveState(state);
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Compute hash for a file.
 * - Files <= 50MB: SHA-256 of content (true integrity check)
 * - Files > 50MB: MD5 of size:mtime (fast approximation)
 */
function fileHash(filePath, size, mtime) {
    if (size <= CONTENT_HASH_LIMIT) {
        try {
            const data = fs.readFileSync(filePath);
            return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
        } catch (e) {
            // Fallback to size+mtime if unreadable
            return 'meta:' + crypto.createHash('md5').update(`${size}:${Math.floor(mtime)}`).digest('hex');
        }
    }
    // Large files — size+mtime
    return 'meta:' + crypto.createHash('md5').update(`${size}:${Math.floor(mtime)}`).digest('hex');
}

/**
 * Full SHA-256 of file content (for conflict resolution, no size limit)
 */
function fullHash(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (e) {
        return null;
    }
}

// ── Change Detection ─────────────────────────────────────────────────────────

/**
 * Pre-scan all selected categories to detect what changed since last sync.
 * Returns { toAdd, toUpdate, toRemove, unchanged, totalFiles, totalBytes, scanTimeMs }
 *
 * @param {object} state - Current sync state (with syncedFileHashes)
 * @param {object} categorySelections - { catId: bool }
 * @param {function} onProgress - Optional callback(scanned, total, currentFile)
 */
function detectChangedFiles(state, categorySelections, onProgress) {
    const t0 = Date.now();
    const toAdd = [];       // New files not in previous sync
    const toUpdate = [];    // Files whose hash changed
    const toRemove = [];    // Files in previous sync but no longer present
    const unchanged = [];   // Files with matching hash
    const currentHashes = {};

    // Step 1: Count total files across selected categories (fast readdir walk)
    const selectedCats = Object.keys(categorySelections).filter(id => categorySelections[id]);
    let totalFiles = 0;
    let totalBytes = 0;
    const allFiles = [];

    for (const catId of selectedCats) {
        const catScan = scanner.scanCategory(catId);
        if (!catScan) continue;
        for (const file of catScan.files) {
            allFiles.push(file);
            totalFiles++;
            totalBytes += file.size;
        }
    }

    // Step 2: Hash each file and compare against stored hashes
    let scanned = 0;
    for (const file of allFiles) {
        scanned++;
        const hash = fileHash(file.path, file.size, file.mtime);
        currentHashes[file.relativePath] = hash;

        const prevHash = state.syncedFileHashes[file.relativePath];
        if (!prevHash) {
            toAdd.push(file.relativePath);
        } else if (prevHash !== hash) {
            toUpdate.push(file.relativePath);
        } else {
            unchanged.push(file.relativePath);
        }

        // Report progress every 200 files
        if (onProgress && scanned % 200 === 0) {
            onProgress(scanned, totalFiles, file.relativePath);
        }
    }

    // Step 3: Detect deletions — files in stored hashes but not in current scan
    for (const relPath of Object.keys(state.syncedFileHashes)) {
        if (!currentHashes[relPath]) {
            toRemove.push(relPath);
        }
    }

    // Final progress report
    if (onProgress) onProgress(totalFiles, totalFiles, 'done');

    return {
        toAdd,
        toUpdate,
        toRemove,
        unchanged,
        currentHashes,
        totalFiles,
        totalBytes,
        changedCount: toAdd.length + toUpdate.length + toRemove.length,
        scanTimeMs: Date.now() - t0
    };
}

/**
 * Legacy detectChanges wrapper (for backward compat with dashboard status display)
 */
function detectChanges(state, categories) {
    const result = detectChangedFiles(state, categories);
    return {
        changes: {
            added: result.toAdd,
            modified: result.toUpdate,
            deleted: result.toRemove,
            unchanged: result.unchanged
        },
        currentHashes: result.currentHashes
    };
}

// ── State Updates ────────────────────────────────────────────────────────────

function updateSyncHashes(state, currentHashes) {
    state.syncedFileHashes = { ...currentHashes };
    saveState(state);
}

function resetState() {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
}

// ── Machine ID ───────────────────────────────────────────────────────────────

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
    detectChangedFiles,
    updateSyncHashes,
    resetState,
    fullHash,
    fileHash,
    STATE_FILE
};
