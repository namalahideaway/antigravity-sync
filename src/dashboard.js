// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Dashboard Webview
// Premium sync dashboard with status, categories, history, and controls
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const path = require('path');
const scanner = require('./scanner');
const syncState = require('./syncState');
const github = require('./github');

let panel = null;

/**
 * Create or show the dashboard webview
 */
function createOrShow(context, extensionUri) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'agSyncDashboard',
        'AG Sync Dashboard',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
        }
    );

    panel.onDidDispose(() => { panel = null; });

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (msg) => {
        try {
            switch (msg.command) {
                case 'refresh':
                    await sendDashboardData(context);
                    break;
                case 'export':
                    await vscode.commands.executeCommand('agSync.export');
                    break;
                case 'import':
                    await vscode.commands.executeCommand('agSync.import');
                    break;
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
    sendDashboardData(context);
}

/**
 * Send current data to the dashboard
 */
async function sendDashboardData(context) {
    if (!panel) return;

    const state = syncState.loadState();
    const scanResult = scanner.scanAll();
    const ghAvailable = github.isGhCliAvailable();
    const ghUser = ghAvailable ? github.getGhUsername() : null;

    // Get category selections
    let selections = state.categorySelections;
    if (!selections) {
        const excludes = vscode.workspace.getConfiguration('agSync').get('excludeCategories', []);
        selections = scanner.getDefaultSelections(excludes);
    }

    // Detect changes
    let changes = null;
    try {
        const result = syncState.detectChanges(state, selections);
        changes = {
            added: result.changes.added.length,
            modified: result.changes.modified.length,
            deleted: result.changes.deleted.length,
            unchanged: result.changes.unchanged.length
        };
    } catch (e) { }

    panel.webview.postMessage({
        type: 'update',
        data: {
            state,
            scan: {
                categories: Object.fromEntries(
                    Object.entries(scanResult.categories).map(([id, cat]) => [id, {
                        id: cat.id,
                        label: cat.label,
                        description: cat.description,
                        icon: cat.icon,
                        fileCount: cat.fileCount,
                        totalSize: cat.totalSize,
                        totalSizeFormatted: cat.totalSizeFormatted,
                        included: selections[id] !== false
                    }])
                ),
                grandTotalFiles: scanResult.grandTotalFiles,
                grandTotalSizeFormatted: scanResult.grandTotalSizeFormatted
            },
            github: {
                available: ghAvailable,
                username: ghUser,
                repo: state.githubRepo
            },
            changes,
            selections
        }
    });
}

/**
 * Generate the dashboard HTML
 */
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
    --gradient: linear-gradient(135deg, #1a1e2e 0%, #0d1117 100%);
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Segoe UI',system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); padding:20px; }
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
btn, .btn { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; font-size:13px; transition:all .15s; }
.btn:hover { background:var(--border); color:var(--text-bright); }
.btn.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
.btn.primary:hover { background:#4393e6; }
.btn.green { background:var(--green); color:#fff; border-color:var(--green); }
.btn.green:hover { opacity:.85; }
.btn.danger { border-color:var(--red); color:var(--red); }
.btn.danger:hover { background:var(--red); color:#fff; }
.full-width { grid-column:1/-1; }
.cat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:8px; }
.cat-item { display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,.02); transition:all .15s; cursor:pointer; }
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
.history-item { display:flex; gap:10px; padding:8px 0; border-bottom:1px solid var(--border); font-size:12px; }
.history-item:last-child { border-bottom:none; }
.history-action { padding:2px 8px; border-radius:4px; font-weight:600; font-size:11px; display:inline-block; min-width:45px; text-align:center; }
.history-action.push { background:rgba(88,166,255,.15); color:var(--accent); }
.history-action.pull { background:rgba(63,185,80,.15); color:var(--green); }
.changes-bar { display:flex; gap:12px; margin:8px 0; font-size:12px; }
.changes-bar span { display:flex; align-items:center; gap:4px; }
.badge { display:inline-block; padding:1px 6px; border-radius:6px; font-size:11px; font-weight:600; }
.badge.added { background:rgba(63,185,80,.15); color:var(--green); }
.badge.modified { background:rgba(210,153,34,.15); color:var(--orange); }
.badge.deleted { background:rgba(248,81,73,.15); color:var(--red); }
.spinner { display:inline-block; width:14px; height:14px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .6s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.empty { color:var(--text-dim); font-style:italic; font-size:13px; padding:12px 0; }
</style>
</head>
<body>
<h1>AG Sync Dashboard</h1>
<p class="subtitle">Export, import, and sync your Antigravity data between computers</p>

<div class="grid">
    <!-- GitHub Status -->
    <div class="card">
        <h2><span class="dot" id="ghDot"></span> GitHub Connection</h2>
        <div class="stat"><span class="label">Status</span><span class="value" id="ghStatus">Checking...</span></div>
        <div class="stat"><span class="label">Username</span><span class="value" id="ghUser">-</span></div>
        <div class="stat"><span class="label">Sync Repo</span><span class="value" id="ghRepo">-</span></div>
        <div class="actions">
            <button class="btn" onclick="post('connectGithub')">Connect GitHub</button>
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
        <div class="cat-grid" id="catGrid"></div>
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

    // Sync status
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
    }

    // Categories
    const grid = document.getElementById('catGrid');
    grid.innerHTML = '';
    for (const [id, cat] of Object.entries(d.scan.categories)) {
        const included = cat.included;
        const el = document.createElement('div');
        el.className = 'cat-item' + (included ? '' : ' excluded');
        el.innerHTML = '<div class="cat-toggle ' + (included ? 'on' : '') + '"></div>' +
            '<div class="cat-info"><div class="cat-name">' + cat.label + '</div>' +
            '<div class="cat-meta">' + cat.fileCount + ' files | ' + cat.totalSizeFormatted + '</div></div>';
        el.onclick = () => post('toggleCategory', { categoryId: id, enabled: !included });
        grid.appendChild(el);
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

function formatTime(iso) {
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now - d;
        if (diffMs < 60000) return 'just now';
        if (diffMs < 3600000) return Math.floor(diffMs/60000) + 'm ago';
        if (diffMs < 86400000) return Math.floor(diffMs/3600000) + 'h ago';
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    } catch(e) { return iso; }
}

// Initial request
post('refresh');
</script>
</body>
</html>`;
}

/**
 * Update the dashboard if it's open
 */
async function refresh(context) {
    if (panel) {
        await sendDashboardData(context);
    }
}

module.exports = { createOrShow, refresh };
