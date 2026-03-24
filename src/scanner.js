// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Data Scanner
// Scans and categorizes all Antigravity data directories
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const AG_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const GEMINI_ROOT = path.join(os.homedir(), '.gemini');

// Category definitions — each maps to one or more directories/files
const CATEGORIES = {
    chats: {
        label: 'Chats',
        description: 'Conversation history files',
        dirs: ['conversations', 'conversations_backup', 'conversations_full'],
        files: [],
        defaultInclude: true,
        icon: '$(comment-discussion)'
    },
    brain: {
        label: 'Brain',
        description: 'Per-conversation artifacts, plans, walkthroughs',
        dirs: ['brain'],
        files: [],
        defaultInclude: true,
        icon: '$(brain)'
    },
    knowledge: {
        label: 'Knowledge',
        description: 'Distilled knowledge items and artifacts',
        dirs: ['knowledge'],
        files: [],
        defaultInclude: true,
        icon: '$(book)'
    },
    scratch: {
        label: 'Projects (scratch)',
        description: 'User project files created by AG',
        dirs: ['scratch'],
        files: [],
        defaultInclude: true,
        icon: '$(folder)'
    },
    recordings: {
        label: 'Browser Recordings',
        description: 'Recorded browser sessions (can be very large)',
        dirs: ['browser_recordings'],
        files: [],
        defaultInclude: false,
        icon: '$(device-camera-video)'
    },
    config: {
        label: 'Configuration',
        description: 'Settings, MCP config, global rules',
        dirs: [],
        files: ['mcp_config.json', 'user_settings.pb', 'installation_id', 'browserOnboardingStatus.txt'],
        parentFiles: ['GEMINI.md'],
        defaultInclude: true,
        icon: '$(gear)'
    },
    annotations: {
        label: 'Annotations & Context',
        description: 'Conversation annotations, implicit context, context state',
        dirs: ['annotations', 'implicit', 'context_state'],
        files: [],
        defaultInclude: true,
        icon: '$(note)'
    },
    prompting: {
        label: 'Prompting',
        description: 'Prompting configuration and browser settings',
        dirs: ['prompting'],
        files: [],
        defaultInclude: true,
        icon: '$(terminal)'
    },
    html_artifacts: {
        label: 'HTML Artifacts',
        description: 'Generated HTML content',
        dirs: ['html_artifacts'],
        files: [],
        defaultInclude: true,
        icon: '$(file-code)'
    },
    code_tracker: {
        label: 'Code Tracker',
        description: 'Code tracking data',
        dirs: ['code_tracker'],
        files: [],
        defaultInclude: true,
        icon: '$(pulse)'
    },
    playground: {
        label: 'Playground',
        description: 'Playground files',
        dirs: ['playground'],
        files: [],
        defaultInclude: true,
        icon: '$(beaker)'
    },
    daemon: {
        label: 'Daemon',
        description: 'Daemon configuration',
        dirs: ['daemon'],
        files: [],
        defaultInclude: true,
        icon: '$(server)'
    }
};

/**
 * Recursively get all files in a directory
 */
function walkDir(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath, fileList);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    fileList.push({
                        path: fullPath,
                        relativePath: path.relative(AG_ROOT, fullPath),
                        size: stat.size,
                        mtime: stat.mtimeMs,
                        mtimeISO: stat.mtime.toISOString()
                    });
                } catch (e) { /* skip unreadable files */ }
            }
        }
    } catch (e) { /* skip unreadable dirs */ }
    return fileList;
}

/**
 * Compute SHA-256 hash of a file
 */
function hashFile(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (e) {
        return null;
    }
}

/**
 * Scan a single category and return statistics
 */
function scanCategory(categoryId) {
    const cat = CATEGORIES[categoryId];
    if (!cat) return null;

    const files = [];

    // Scan directories
    for (const dir of (cat.dirs || [])) {
        const dirPath = path.join(AG_ROOT, dir);
        walkDir(dirPath, files);
    }

    // Scan individual files in AG root
    for (const file of (cat.files || [])) {
        const filePath = path.join(AG_ROOT, file);
        if (fs.existsSync(filePath)) {
            try {
                const stat = fs.statSync(filePath);
                files.push({
                    path: filePath,
                    relativePath: file,
                    size: stat.size,
                    mtime: stat.mtimeMs,
                    mtimeISO: stat.mtime.toISOString()
                });
            } catch (e) { /* skip */ }
        }
    }

    // Scan parent .gemini files
    for (const file of (cat.parentFiles || [])) {
        const filePath = path.join(GEMINI_ROOT, file);
        if (fs.existsSync(filePath)) {
            try {
                const stat = fs.statSync(filePath);
                files.push({
                    path: filePath,
                    relativePath: path.join('__gemini_root__', file),
                    size: stat.size,
                    mtime: stat.mtimeMs,
                    mtimeISO: stat.mtime.toISOString()
                });
            } catch (e) { /* skip */ }
        }
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    return {
        id: categoryId,
        label: cat.label,
        description: cat.description,
        icon: cat.icon,
        defaultInclude: cat.defaultInclude,
        fileCount: files.length,
        totalSize,
        totalSizeFormatted: formatSize(totalSize),
        files
    };
}

/**
 * Scan ALL categories
 */
function scanAll() {
    const results = {};
    let grandTotalFiles = 0;
    let grandTotalSize = 0;

    for (const catId of Object.keys(CATEGORIES)) {
        const scan = scanCategory(catId);
        if (scan) {
            results[catId] = scan;
            grandTotalFiles += scan.fileCount;
            grandTotalSize += scan.totalSize;
        }
    }

    return {
        timestamp: new Date().toISOString(),
        agRoot: AG_ROOT,
        geminiRoot: GEMINI_ROOT,
        categories: results,
        grandTotalFiles,
        grandTotalSize,
        grandTotalSizeFormatted: formatSize(grandTotalSize)
    };
}

/**
 * Get default include/exclude based on settings
 */
function getDefaultSelections(excludeOverrides = []) {
    const selections = {};
    for (const [id, cat] of Object.entries(CATEGORIES)) {
        selections[id] = excludeOverrides.includes(id) ? false : cat.defaultInclude;
    }
    return selections;
}

/**
 * Format byte size to human-readable
 */
function formatSize(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' bytes';
}

module.exports = {
    CATEGORIES,
    AG_ROOT,
    GEMINI_ROOT,
    scanCategory,
    scanAll,
    getDefaultSelections,
    walkDir,
    hashFile,
    formatSize
};
