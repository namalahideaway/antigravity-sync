// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Import Engine
// Restores AG data from a ZIP export with conflict resolution
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const scanner = require('./scanner');

/**
 * Import data from a ZIP file
 * @param {string} zipPath - Path to the ZIP file
 * @param {Object} categorySelections - { categoryId: boolean } which categories to import
 * @param {string} conflictMode - 'overwrite' | 'skip' | 'newer-wins'
 * @param {vscode.Progress} progress - VS Code progress reporter
 * @returns {Promise<Object>} Import result summary
 */
async function importData(zipPath, categorySelections, conflictMode, progress) {
    const extractDir = path.join(os.tmpdir(), `ag-import-${Date.now()}`);
    const result = {
        success: true,
        filesImported: 0,
        filesSkipped: 0,
        filesOverwritten: 0,
        errors: [],
        manifest: null
    };

    try {
        // Extract ZIP
        progress?.report({ message: 'Extracting archive...', increment: 10 });
        fs.mkdirSync(extractDir, { recursive: true });

        const psCmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`;
        execSync(`powershell -NoProfile -Command "${psCmd}"`, {
            timeout: 600000,
            windowsHide: true
        });

        // Read manifest
        const manifestPath = path.join(extractDir, '_ag_sync_manifest.json');
        if (fs.existsSync(manifestPath)) {
            result.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }

        progress?.report({ message: 'Analyzing contents...', increment: 5 });

        // Ensure target directories exist
        fs.mkdirSync(scanner.AG_ROOT, { recursive: true });
        fs.mkdirSync(scanner.GEMINI_ROOT, { recursive: true });

        // Restore antigravity data
        const srcAG = path.join(extractDir, 'antigravity');
        if (fs.existsSync(srcAG)) {
            progress?.report({ message: 'Importing Antigravity data...', increment: 5 });

            const entries = fs.readdirSync(srcAG, { withFileTypes: true });
            const totalEntries = entries.length;
            let processed = 0;

            for (const entry of entries) {
                processed++;
                const pctInc = Math.round((processed / totalEntries) * 60);

                // Check if this entry belongs to a selected category
                const catId = identifyCategory(entry.name);
                if (catId && categorySelections && categorySelections[catId] === false) {
                    result.filesSkipped++;
                    continue;
                }

                const srcPath = path.join(srcAG, entry.name);
                const dstPath = path.join(scanner.AG_ROOT, entry.name);

                if (entry.isDirectory()) {
                    progress?.report({ message: `Importing ${entry.name}...`, increment: pctInc > 1 ? 1 : 0 });
                    const dirResult = mergeDirRecursive(srcPath, dstPath, conflictMode);
                    result.filesImported += dirResult.imported;
                    result.filesSkipped += dirResult.skipped;
                    result.filesOverwritten += dirResult.overwritten;
                    result.errors.push(...dirResult.errors);
                } else {
                    const fileResult = mergeFile(srcPath, dstPath, conflictMode);
                    if (fileResult.action === 'imported' || fileResult.action === 'overwritten') {
                        result.filesImported++;
                        if (fileResult.action === 'overwritten') result.filesOverwritten++;
                    } else {
                        result.filesSkipped++;
                    }
                    if (fileResult.error) result.errors.push(fileResult.error);
                }
            }
        }

        // Restore parent .gemini files
        const srcGR = path.join(extractDir, 'gemini-root');
        if (fs.existsSync(srcGR)) {
            progress?.report({ message: 'Importing global config...', increment: 5 });
            const entries = fs.readdirSync(srcGR, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile()) {
                    const srcPath = path.join(srcGR, entry.name);
                    const dstPath = path.join(scanner.GEMINI_ROOT, entry.name);
                    const fileResult = mergeFile(srcPath, dstPath, conflictMode);
                    if (fileResult.action === 'imported' || fileResult.action === 'overwritten') {
                        result.filesImported++;
                    }
                }
            }
        }

        progress?.report({ message: 'Done!', increment: 10 });

    } catch (e) {
        result.success = false;
        result.errors.push(`Import failed: ${e.message}`);
    } finally {
        // Cleanup
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) { }
    }

    return result;
}

/**
 * Identify which category a directory/file belongs to
 */
function identifyCategory(name) {
    const dirToCategory = {
        'conversations': 'chats', 'conversations_backup': 'chats', 'conversations_full': 'chats',
        'brain': 'brain', 'knowledge': 'knowledge', 'scratch': 'scratch',
        'browser_recordings': 'recordings', 'annotations': 'annotations',
        'implicit': 'annotations', 'context_state': 'annotations',
        'prompting': 'prompting', 'html_artifacts': 'html_artifacts',
        'code_tracker': 'code_tracker', 'playground': 'playground', 'daemon': 'daemon'
    };
    return dirToCategory[name] || null;
}

/**
 * Merge a directory recursively with conflict resolution
 */
function mergeDirRecursive(src, dst, conflictMode) {
    const result = { imported: 0, skipped: 0, overwritten: 0, errors: [] };

    fs.mkdirSync(dst, { recursive: true });

    try {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const dstPath = path.join(dst, entry.name);

            if (entry.isDirectory()) {
                const subResult = mergeDirRecursive(srcPath, dstPath, conflictMode);
                result.imported += subResult.imported;
                result.skipped += subResult.skipped;
                result.overwritten += subResult.overwritten;
                result.errors.push(...subResult.errors);
            } else {
                const fileResult = mergeFile(srcPath, dstPath, conflictMode);
                if (fileResult.action === 'imported') result.imported++;
                else if (fileResult.action === 'overwritten') { result.imported++; result.overwritten++; }
                else if (fileResult.action === 'skipped') result.skipped++;
                if (fileResult.error) result.errors.push(fileResult.error);
            }
        }
    } catch (e) {
        result.errors.push(`Error reading ${src}: ${e.message}`);
    }

    return result;
}

/**
 * Merge a single file with conflict resolution
 */
function mergeFile(srcPath, dstPath, conflictMode) {
    try {
        const dstExists = fs.existsSync(dstPath);

        if (!dstExists) {
            // No conflict — just copy
            fs.mkdirSync(path.dirname(dstPath), { recursive: true });
            fs.copyFileSync(srcPath, dstPath);
            return { action: 'imported' };
        }

        // File exists — apply conflict mode
        switch (conflictMode) {
            case 'overwrite':
                fs.copyFileSync(srcPath, dstPath);
                return { action: 'overwritten' };

            case 'skip':
                return { action: 'skipped' };

            case 'newer-wins': {
                const srcStat = fs.statSync(srcPath);
                const dstStat = fs.statSync(dstPath);
                if (srcStat.mtimeMs > dstStat.mtimeMs) {
                    fs.copyFileSync(srcPath, dstPath);
                    return { action: 'overwritten' };
                }
                return { action: 'skipped' };
            }

            default:
                fs.copyFileSync(srcPath, dstPath);
                return { action: 'overwritten' };
        }
    } catch (e) {
        return { action: 'error', error: `Failed to merge ${path.basename(srcPath)}: ${e.message}` };
    }
}

/**
 * Read manifest from a ZIP without full extraction
 */
async function readManifest(zipPath) {
    const extractDir = path.join(os.tmpdir(), `ag-manifest-${Date.now()}`);
    try {
        fs.mkdirSync(extractDir, { recursive: true });
        const psCmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`;
        execSync(`powershell -NoProfile -Command "${psCmd}"`, {
            timeout: 300000,
            windowsHide: true
        });
        const manifestPath = path.join(extractDir, '_ag_sync_manifest.json');
        if (fs.existsSync(manifestPath)) {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }
        return null;
    } finally {
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) { }
    }
}

module.exports = { importData, readManifest };
