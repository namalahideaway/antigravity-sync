// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Dashboard Webview
// Premium sync dashboard with status, categories, history, and controls
// Uses lightweight directory-level scanning (not full recursive file walks)
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const scanner = require('./scanner');
const syncState = require('./syncState');
const github = require('./github');

let panel = null;

function createOrShow(context) {
    if (panel) { panel.reveal(vscode.ViewColumn.One); return; }

    panel = vscode.window.createWebviewPanel(
        'agSyncDashboard', 'AG Sync Dashboard', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.onDidDispose(() => { panel = null; });

    panel.webview.onDidReceiveMessage(async (msg) => {
        try {
            switch (msg.command) {
                case 'refresh': await sendDashboardData(context); break;
                case 'export': await vscode.commands.executeCommand('agSync.export'); break;
                case 'import': await vscode.commands.executeCommand('agSync.import'); break;
                case 'push':
                    await vscode.commands.executeCommand('agSync.push');
                    await sendDashboardData(context);
                    break;
                case 'pull':
                    await vscode.commands.executeCommand('agSync.pull');
                    await sendDashboardData(context);
                    break;
                case 'toggleCategory': {
                    const state = syncState.loadState();
                    if (!state.categorySelections) {
                        state.categorySelections = scanner.getDefaultSelections(
                            vscode.workspace.getConfiguration('agSync').get('excludeCategories', [])
                        );
                    }
                    state.categorySelections[msg.categoryId] = msg.enabled;
                    syncState.saveState(state);
                    await sendDashboardData(context);
                    break;
                }
                case 'connectGithub':
                    await vscode.commands.executeCommand('agSync.githubLogin');
                    await sendDashboardData(context);
                    break;
                case 'selectRepo':
                    await vscode.commands.executeCommand('agSync.githubSelectRepo');
                    await sendDashboardData(context);
                    break;
                case 'resetSync':
                    await vscode.commands.executeCommand('agSync.resetSync');
                    await sendDashboardData(context);
                    break;
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Dashboard action failed: ${e.message}`);
        }
    });

    panel.webview.html = getDashboardHtml();

    // Send data immediately — use lightweight scan so it's instant
    sendDashboardData(context);
}

/**
 * Lightweight scan — gets directory sizes using stat, NOT recursive file walks.
 * This prevents the 307K file browser_recordings from blocking the UI for minutes.
 */
function lightweightScan() {
    const results = {};
    for (const [catId, catDef] of Object.entries(scanner.CATEGORIES)) {
        let exists = false;
        let sizeEstimate = '...';

        for (const dir of (catDef.dirs || [])) {
            const dirPath = path.join(scanner.AG_ROOT, dir);
            if (fs.existsSync(dirPath)) {
                exists = true;
                // Quick count: only top-level entries, not recursive
                try {
                    const entries = fs.readdirSync(dirPath);
                    sizeEstimate = `${entries.length} items`;
                } catch (e) { sizeEstimate = 'exists'; }
            }
        }
        for (const file of (catDef.files || [])) {
            if (fs.existsSync(path.join(scanner.AG_ROOT, file))) exists = true;
        }
        for (const file of (catDef.parentFiles || [])) {
            if (fs.existsSync(path.join(scanner.GEMINI_ROOT, file))) exists = true;
        }

        results[catId] = {
            id: catId,
            label: catDef.label,
            description: catDef.description,
            icon: catDef.icon,
            fileCount: -1, // -1 signals "not yet scanned"
            totalSize: 0,
            totalSizeFormatted: exists ? sizeEstimate : 'empty',
            included: true // will be overridden
        };
    }
    return results;
}

/**
 * Send dashboard data — fast path uses lightweight scan
 */
async function sendDashboardData(context) {
    if (!panel) return;

    const state = syncState.loadState();

    // GitHub status check
    let ghAvailable = false;
    let ghUser = null;
    try {
        ghAvailable = github.isGhCliAvailable();
        if (ghAvailable) ghUser = github.getGhUsername();
    } catch (e) {
        console.error('[AG Sync] GitHub check failed:', e.message);
    }

    // Category selections
    let selections = state.categorySelections;
    if (!selections) {
        const excludes = vscode.workspace.getConfiguration('agSync').get('excludeCategories', []);
        selections = scanner.getDefaultSelections(excludes);
    }

    // Use lightweight scan (instant) instead of full recursive scan
    const categories = lightweightScan();

    // Apply selections
    for (const id of Object.keys(categories)) {
        categories[id].included = selections[id] !== false;
    }

    panel.webview.postMessage({
        type: 'update',
        data: {
            state,
            scan: { categories, grandTotalFiles: 0, grandTotalSizeFormatted: 'Use Scan Data for details' },
            github: { available: ghAvailable, username: ghUser, repo: state.githubRepo },
            changes: null,
            selections
        }
    });
}

function getDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AG Sync Dashboard</title>
<style>
:root {
    --bg: #0d1117; --card: #161b22; --border: #30363d;
    --text: #c9d1d9; --text-dim: #8b949e; --text-bright: #f0f6fc;
    --accent: #58a6ff; --green: #3fb950; --red: #f85149;
    --orange: #d29922; --purple: #bc8cff;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Segoe UI',system-ui,sans-serif; background:var(--bg); color:var(--text); padding:20px; }
h1 { color:var(--text-bright); font-size:24px; margin-bottom:4px; }
.subtitle { color:var(--text-dim); font-size:13px; margin-bottom:20px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:18px; }
.card h2 { color:var(--text-bright); font-size:15px; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
.card h2 .dot { width:8px; height:8px; border-radius:50%; }
.dot.green { background:var(--green); box-shadow:0 0 8px var(--green); }
.dot.red { background:var(--red); }
.dot.orange { background:var(--orange); }
.stat { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px; }
.stat:last-child { border-bottom:none; }
.stat .label { color:var(--text-dim); }
.stat .value { color:var(--text-bright); font-weight:600; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
.btn { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; font-size:13px; transition:all .15s; font-family:inherit; }
.btn:hover { background:var(--border); color:var(--text-bright); }
.btn.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
.btn.primary:hover { background:#4393e6; }
.btn.green { background:var(--green); color:#fff; border-color:var(--green); }
.btn.green:hover { opacity:.85; }
.btn.danger { border-color:var(--red); color:var(--red); }
.btn.danger:hover { background:var(--red); color:#fff; }
.full-width { grid-column:1/-1; }
.cat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:8px; }
.cat-item { display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,.02); transition:all .15s; cursor:pointer; user-select:none; }
.cat-item:hover { background:rgba(255,255,255,.05); }
.cat-item.excluded { opacity:.45; }
.cat-toggle { width:36px; height:20px; border-radius:10px; background:var(--border); position:relative; transition:background .2s; flex-shrink:0; }
.cat-toggle.on { background:var(--green); }
.cat-toggle::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform .2s; }
.cat-toggle.on::after { transform:translateX(16px); }
.cat-info { flex:1; min-width:0; }
.cat-name { color:var(--text-bright); font-size:13px; font-weight:600; }
.cat-meta { color:var(--text-dim); font-size:11px; }
.history { max-height:200px; overflow-y:auto; }
.history-item { display:flex; gap:10px; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); font-size:12px; }
.history-item:last-child { border-bottom:none; }
.history-action { padding:2px 8px; border-radius:4px; font-weight:600; font-size:11px; min-width:45px; text-align:center; }
.history-action.push { background:rgba(88,166,255,.15); color:var(--accent); }
.history-action.pull { background:rgba(63,185,80,.15); color:var(--green); }
.changes-bar { display:flex; gap:12px; margin:8px 0; font-size:12px; }
.badge { display:inline-block; padding:1px 6px; border-radius:6px; font-size:11px; font-weight:600; }
.badge.added { background:rgba(63,185,80,.15); color:var(--green); }
.badge.modified { background:rgba(210,153,34,.15); color:var(--orange); }
.badge.deleted { background:rgba(248,81,73,.15); color:var(--red); }
.empty { color:var(--text-dim); font-style:italic; font-size:13px; padding:12px 0; }
.loading { color:var(--orange); font-size:13px; }
</style>
</head>
<body>
<h1>AG Sync Dashboard</h1>
<p class="subtitle">Export, import, and sync your Antigravity data between computers</p>

<div class="grid">
    <!-- GitHub Status -->
    <div class="card">
        <h2><span class="dot" id="ghDot"></span> GitHub Connection</h2>
        <div class="stat"><span class="label">Status</span><span class="value" id="ghStatus">Loading...</span></div>
        <div class="stat"><span class="label">Username</span><span class="value" id="ghUser">-</span></div>
        <div class="stat"><span class="label">Sync Repo</span><span class="value" id="ghRepo">-</span></div>
        <div class="actions">
            <button class="btn primary" onclick="post('connectGithub')" id="btnConnect">Connect GitHub</button>
            <button class="btn" onclick="post('selectRepo')">Select Repo</button>
        </div>
    </div>

    <!-- Sync Status -->
    <div class="card">
        <h2><span class="dot" id="syncDot"></span> Sync Status</h2>
        <div class="stat"><span class="label">Last Push</span><span class="value" id="lastPush">Never</span></div>
        <div class="stat"><span class="label">Last Pull</span><span class="value" id="lastPull">Never</span></div>
        <div id="changesArea" class="changes-bar"></div>
        <div class="actions">
            <button class="btn primary" onclick="post('push')">Push to GitHub</button>
            <button class="btn green" onclick="post('pull')">Pull from GitHub</button>
            <button class="btn" onclick="post('refresh')">Refresh</button>
        </div>
    </div>

    <!-- Quick Actions -->
    <div class="card full-width">
        <h2>Quick Actions</h2>
        <div class="actions">
            <button class="btn primary" onclick="post('export')">Export to ZIP</button>
            <button class="btn green" onclick="post('import')">Import from ZIP</button>
            <button class="btn" onclick="post('push')">Push All</button>
            <button class="btn" onclick="post('pull')">Pull All</button>
            <button class="btn danger" onclick="post('resetSync')">Reset Sync State</button>
        </div>
    </div>

    <!-- Categories -->
    <div class="card full-width">
        <h2>Data Categories</h2>
        <p class="subtitle" style="margin-bottom:12px">Toggle categories to include or exclude from sync operations.</p>
        <div class="cat-grid" id="catGrid"><p class="loading">Loading categories...</p></div>
    </div>

    <!-- Sync History -->
    <div class="card full-width">
        <h2>Sync History</h2>
        <div class="history" id="historyList">
            <p class="empty">No sync history yet.</p>
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function post(cmd, data) { vscode.postMessage({ command: cmd, ...data }); }

window.addEventListener('message', e => {
    if (e.data.type === 'update') render(e.data.data);
});

function render(d) {
    // GitHub
    const ghOk = d.github.available;
    document.getElementById('ghDot').className = 'dot ' + (ghOk ? (d.github.repo ? 'green' : 'orange') : 'red');
    document.getElementById('ghStatus').textContent = ghOk ? 'Connected' : 'Not connected';
    document.getElementById('ghUser').textContent = d.github.username || '-';
    document.getElementById('ghRepo').textContent = d.github.repo || 'Not configured';
    document.getElementById('btnConnect').textContent = ghOk ? 'Connected' : 'Connect GitHub';

    // Sync
    const hasSynced = d.state.lastPushTime || d.state.lastPullTime;
    document.getElementById('syncDot').className = 'dot ' + (hasSynced ? 'green' : 'orange');
    document.getElementById('lastPush').textContent = d.state.lastPushTime ? formatTime(d.state.lastPushTime) : 'Never';
    document.getElementById('lastPull').textContent = d.state.lastPullTime ? formatTime(d.state.lastPullTime) : 'Never';

    // Changes
    const ca = document.getElementById('changesArea');
    if (d.changes) {
        ca.innerHTML = [
            d.changes.added > 0 ? '<span><span class="badge added">+' + d.changes.added + ' new</span></span>' : '',
            d.changes.modified > 0 ? '<span><span class="badge modified">~' + d.changes.modified + ' modified</span></span>' : '',
            d.changes.deleted > 0 ? '<span><span class="badge deleted">-' + d.changes.deleted + ' deleted</span></span>' : '',
        ].filter(Boolean).join('') || '<span style="color:var(--text-dim)">No changes detected</span>';
    } else {
        ca.innerHTML = '<span style="color:var(--text-dim)">Run full scan for change detection</span>';
    }

    // Categories
    const grid = document.getElementById('catGrid');
    grid.innerHTML = '';
    if (d.scan && d.scan.categories) {
        for (const [id, cat] of Object.entries(d.scan.categories)) {
            const included = cat.included;
            const el = document.createElement('div');
            el.className = 'cat-item' + (included ? '' : ' excluded');
            el.innerHTML = '<div class="cat-toggle ' + (included ? 'on' : '') + '"></div>' +
                '<div class="cat-info"><div class="cat-name">' + esc(cat.label) + '</div>' +
                '<div class="cat-meta">' + esc(cat.totalSizeFormatted) + '</div></div>';
            el.onclick = () => post('toggleCategory', { categoryId: id, enabled: !included });
            grid.appendChild(el);
        }
    }

    // History
    const hl = document.getElementById('historyList');
    if (d.state.syncHistory && d.state.syncHistory.length > 0) {
        hl.innerHTML = d.state.syncHistory.map(h =>
            '<div class="history-item">' +
            '<span class="history-action ' + h.action + '">' + h.action.toUpperCase() + '</span>' +
            '<span style="color:var(--text-dim)">' + formatTime(h.timestamp) + '</span>' +
            '<span>' + (h.filesCount || h.filesImported || 0) + ' files</span>' +
            (h.commit ? '<span style="color:var(--text-dim);font-family:monospace">' + h.commit.slice(0,7) + '</span>' : '') +
            '</div>'
        ).join('');
    } else {
        hl.innerHTML = '<p class="empty">No sync history yet.</p>';
    }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function formatTime(iso) {
    try {
        const d = new Date(iso), now = new Date(), ms = now - d;
        if (ms < 60000) return 'just now';
        if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
        if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    } catch(e) { return iso; }
}

post('refresh');
</script>
</body>
</html>`;
}

async function refresh(context) {
    if (panel) await sendDashboardData(context);
}

module.exports = { createOrShow, refresh };
