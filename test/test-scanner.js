// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Scanner Test
// Validates that the scanner correctly discovers all AG data categories
// ═══════════════════════════════════════════════════════════════════════════════

const scanner = require('../src/scanner');

function test() {
    console.log('=== AG Sync Scanner Test ===\n');

    // Test 1: AG_ROOT exists
    const fs = require('fs');
    const rootExists = fs.existsSync(scanner.AG_ROOT);
    console.log(`[${rootExists ? 'PASS' : 'FAIL'}] AG_ROOT exists: ${scanner.AG_ROOT}`);
    if (!rootExists) {
        console.log('FATAL: AG_ROOT does not exist. Cannot continue tests.');
        process.exit(1);
    }

    // Test 2: All categories defined
    const catCount = Object.keys(scanner.CATEGORIES).length;
    console.log(`[${catCount === 12 ? 'PASS' : 'FAIL'}] Category count: ${catCount} (expected 12)`);

    // Test 3: Scan all categories
    console.log('\n--- Category Scan ---');
    const scanResult = scanner.scanAll();
    let totalTests = 0, passed = 0;

    for (const [id, cat] of Object.entries(scanResult.categories)) {
        totalTests++;
        const ok = cat.fileCount >= 0 && cat.totalSize >= 0;
        if (ok) passed++;
        console.log(`[${ok ? 'PASS' : 'FAIL'}] ${cat.label}: ${cat.fileCount} files (${cat.totalSizeFormatted})`);
    }

    // Test 4: Grand totals
    totalTests++;
    const totalsOk = scanResult.grandTotalFiles > 0 && scanResult.grandTotalSize > 0;
    if (totalsOk) passed++;
    console.log(`\n[${totalsOk ? 'PASS' : 'FAIL'}] Grand total: ${scanResult.grandTotalFiles} files (${scanResult.grandTotalSizeFormatted})`);

    // Test 5: Default selections
    totalTests++;
    const defaults = scanner.getDefaultSelections([]);
    const defaultsOk = defaults.chats === true && defaults.recordings === false;
    if (defaultsOk) passed++;
    console.log(`[${defaultsOk ? 'PASS' : 'FAIL'}] Default selections: chats=included, recordings=excluded`);

    // Test 6: Exclude overrides
    totalTests++;
    const overrides = scanner.getDefaultSelections(['scratch', 'brain']);
    const overridesOk = overrides.scratch === false && overrides.brain === false && overrides.chats === true;
    if (overridesOk) passed++;
    console.log(`[${overridesOk ? 'PASS' : 'FAIL'}] Exclude overrides work correctly`);

    // Test 7: formatSize
    totalTests++;
    const sizeTests = scanner.formatSize(1024) === '1.00 KB' &&
        scanner.formatSize(1048576) === '1.00 MB' &&
        scanner.formatSize(1073741824) === '1.00 GB';
    if (sizeTests) passed++;
    console.log(`[${sizeTests ? 'PASS' : 'FAIL'}] formatSize utility`);

    console.log(`\n=== Results: ${passed}/${totalTests} tests passed ===`);
    process.exit(passed === totalTests ? 0 : 1);
}

test();
