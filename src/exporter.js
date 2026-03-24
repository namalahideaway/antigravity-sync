// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Export Engine
// Creates selective ZIP archives of AG data with manifest
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const scanner = require('./scanner');

/**
 * Export selected categories to a ZIP file
 * @param {Object} selections - { categoryId: boolean } map of what to include
 * @param {string} outputDir - Directory to save the ZIP in
 * @param {vscode.Progress} progress - VS Code progress reporter
 * @returns {Promise<{zipPath: string, manifest: Object}>}
 */
async function exportData(selections, outputDir, progress) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `antigravity-export-${timestamp}.zip`;
    const stagingDir = path.join(os.tmpdir(), `ag-export-${Date.now()}`);
    const stagingAG = path.join(stagingDir, 'antigravity');
    const stagingGR = path.join(stagingDir, 'gemini-root');

    try {
        // Create staging directories
        fs.mkdirSync(stagingAG, { recursive: true });
        fs.mkdirSync(stagingGR, { recursive: true });

        progress?.report({ message: 'Scanning data...', increment: 5 });

        // Build manifest
        const manifest = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            sourceComputer: os.hostname(),
            sourceUser: os.userInfo().username,
            sourcePlatform: os.platform(),
            categories: {},
            selections: selections,
            totalFiles: 0,
            totalSizeBytes: 0
        };

        const categoryIds = Object.keys(selections).filter(id => selections[id]);
        const totalCategories = categoryIds.length;
        let processedCategories = 0;

        for (const catId of categoryIds) {
            const catDef = scanner.CATEGORIES[catId];
            if (!catDef) continue;

            processedCategories++;
            const pct = Math.round((processedCategories / totalCategories) * 70);
            progress?.report({ message: `Copying ${catDef.label}...`, increment: pct > 5 ? 2 : 1 });

            let catFiles = 0;
            let catSize = 0;

            // Copy directories
            for (const dir of (catDef.dirs || [])) {
                const srcPath = path.join(scanner.AG_ROOT, dir);
                const dstPath = path.join(stagingAG, dir);
                if (fs.existsSync(srcPath)) {
                    copyDirRecursive(srcPath, dstPath);
                    const stats = countDir(dstPath);
                    catFiles += stats.files;
                    catSize += stats.size;
                }
            }

            // Copy individual files
            for (const file of (catDef.files || [])) {
                const srcPath = path.join(scanner.AG_ROOT, file);
                if (fs.existsSync(srcPath)) {
                    const dstPath = path.join(stagingAG, file);
                    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                    fs.copyFileSync(srcPath, dstPath);
                    catFiles++;
                    catSize += fs.statSync(srcPath).size;
                }
            }

            // Copy parent files
            for (const file of (catDef.parentFiles || [])) {
                const srcPath = path.join(scanner.GEMINI_ROOT, file);
                if (fs.existsSync(srcPath)) {
                    const dstPath = path.join(stagingGR, file);
                    fs.copyFileSync(srcPath, dstPath);
                    catFiles++;
                    catSize += fs.statSync(srcPath).size;
                }
            }

            manifest.categories[catId] = {
                label: catDef.label,
                fileCount: catFiles,
                sizeBytes: catSize,
                sizeFormatted: scanner.formatSize(catSize)
            };
            manifest.totalFiles += catFiles;
            manifest.totalSizeBytes += catSize;
        }

        manifest.totalSizeFormatted = scanner.formatSize(manifest.totalSizeBytes);

        // Write manifest
        fs.writeFileSync(
            path.join(stagingDir, '_ag_sync_manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf8'
        );

        // Create ZIP using PowerShell (built-in on Windows)
        progress?.report({ message: 'Compressing...', increment: 10 });

        if (!outputDir) {
            outputDir = path.join(os.homedir(), 'Desktop');
        }
        fs.mkdirSync(outputDir, { recursive: true });

        const zipPath = path.join(outputDir, zipName);

        // Use PowerShell Compress-Archive
        const psCmd = `Compress-Archive -Path "${stagingDir}\\*" -DestinationPath "${zipPath}" -CompressionLevel Optimal -Force`;
        execSync(`powershell -NoProfile -Command "${psCmd}"`, {
            timeout: 600000, // 10 min timeout
            windowsHide: true
        });

        progress?.report({ message: 'Cleaning up...', increment: 5 });

        // Get compressed size
        const zipSize = fs.statSync(zipPath).size;
        manifest.compressedSizeBytes = zipSize;
        manifest.compressedSizeFormatted = scanner.formatSize(zipSize);
        manifest.compressionRatio = ((1 - zipSize / Math.max(manifest.totalSizeBytes, 1)) * 100).toFixed(1) + '%';

        return { zipPath, manifest };

    } finally {
        // Cleanup staging
        try { deleteDirRecursive(stagingDir); } catch (e) { /* ok */ }
    }
}

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        try {
            if (entry.isDirectory()) {
                copyDirRecursive(srcPath, dstPath);
            } else {
                fs.copyFileSync(srcPath, dstPath);
            }
        } catch (e) { /* skip unreadable */ }
    }
}

/**
 * Count files and total size in a directory
 */
function countDir(dir) {
    let files = 0, size = 0;
    if (!fs.existsSync(dir)) return { files, size };
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const sub = countDir(fullPath);
                files += sub.files;
                size += sub.size;
            } else {
                files++;
                try { size += fs.statSync(fullPath).size; } catch (e) { }
            }
        }
    } catch (e) { }
    return { files, size };
}

/**
 * Recursively delete a directory
 */
function deleteDirRecursive(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { exportData };
