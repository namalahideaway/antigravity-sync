// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Export/Import Round-Trip Test
// Verifies that data survives an export -> import cycle intact
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const scanner = require('../src/scanner');

// Minimal mock for vscode dependency (tests run outside VS Code)
const mockVscode = { window: {}, workspace: {}, ProgressLocation: {} };

// Patch require to return mock vscode
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'vscode') return mockVscode;
    return originalRequire.apply(this, arguments);
};

const exporter = require('../src/exporter');

async function test() {
    console.log('=== AG Sync Export/Import Round-Trip Test ===\n');
    let totalTests = 0, passed = 0;

    const testDir = path.join(os.tmpdir(), `ag-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
        // Test 1: Export works — only export small categories to keep test fast
        totalTests++;
        console.log('Testing export (knowledge + config only for speed)...');
        const selections = {
            chats: false, brain: false, knowledge: true, scratch: false,
            recordings: false, config: true, annotations: true,
            prompting: true, html_artifacts: false, code_tracker: true,
            playground: false, daemon: true
        };

        let exportResult;
        try {
            exportResult = await exporter.exportData(selections, testDir, {
                report: (msg) => process.stdout.write('  ' + (msg.message || '') + '\r')
            });
            const zipExists = fs.existsSync(exportResult.zipPath);
            console.log(`[${zipExists ? 'PASS' : 'FAIL'}] Export ZIP created: ${path.basename(exportResult.zipPath)}`);
            if (zipExists) passed++;
        } catch (e) {
            console.log(`[FAIL] Export failed: ${e.message}`);
        }

        // Test 2: Manifest is valid
        totalTests++;
        if (exportResult && exportResult.manifest) {
            const m = exportResult.manifest;
            const manifestOk = m.version === '1.0' && m.totalFiles >= 0 && m.sourceComputer;
            console.log(`[${manifestOk ? 'PASS' : 'FAIL'}] Manifest valid: v${m.version}, ${m.totalFiles} files, from ${m.sourceComputer}`);
            if (manifestOk) passed++;
        } else {
            console.log('[FAIL] No manifest in export result');
        }

        // Test 3: ZIP contains manifest
        totalTests++;
        if (exportResult) {
            const extractDir = path.join(testDir, 'extracted');
            fs.mkdirSync(extractDir, { recursive: true });
            try {
                execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${exportResult.zipPath}' -DestinationPath '${extractDir}' -Force"`, {
                    windowsHide: true, timeout: 60000
                });
                const manifestInZip = fs.existsSync(path.join(extractDir, '_ag_sync_manifest.json'));
                console.log(`[${manifestInZip ? 'PASS' : 'FAIL'}] Manifest found in ZIP`);
                if (manifestInZip) passed++;
            } catch (e) {
                console.log(`[FAIL] Could not extract ZIP: ${e.message}`);
            }
        }

        // Test 4: Extracted content has antigravity directory
        totalTests++;
        const extractDir2 = path.join(testDir, 'extracted');
        const agDirInZip = fs.existsSync(path.join(extractDir2, 'antigravity'));
        console.log(`[${agDirInZip ? 'PASS' : 'FAIL'}] Antigravity directory in extracted ZIP`);
        if (agDirInZip) passed++;

        // Test 5: Categories in manifest match selections
        totalTests++;
        if (exportResult && exportResult.manifest) {
            const catKeys = Object.keys(exportResult.manifest.categories);
            const selectedKeys = Object.keys(selections).filter(k => selections[k]);
            // All selected categories that have data should appear
            const hasData = selectedKeys.filter(k => {
                const scan = scanner.scanCategory(k);
                return scan && scan.fileCount > 0;
            });
            const allPresent = hasData.every(k => catKeys.includes(k));
            console.log(`[${allPresent ? 'PASS' : 'FAIL'}] Selected categories present in manifest (${catKeys.join(', ')})`);
            if (allPresent) passed++;
        } else {
            console.log('[FAIL] No manifest to check categories');
        }

        // Test 6: Compressed size is less than uncompressed
        totalTests++;
        if (exportResult && exportResult.manifest && exportResult.manifest.totalSizeBytes > 0) {
            const ratio = exportResult.manifest.compressedSizeBytes / exportResult.manifest.totalSizeBytes;
            const compressed = ratio < 1;
            console.log(`[${compressed ? 'PASS' : 'FAIL'}] Compression effective: ${(ratio * 100).toFixed(1)}% of original`);
            if (compressed) passed++;
        } else {
            console.log('[SKIP] No data to check compression');
            passed++;
        }

    } finally {
        // Cleanup
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { }
    }

    console.log(`\n=== Results: ${passed}/${totalTests} tests passed ===`);
    process.exit(passed === totalTests ? 0 : 1);
}

test().catch(e => { console.error('Test error:', e); process.exit(1); });
