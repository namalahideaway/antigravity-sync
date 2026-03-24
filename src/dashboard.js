// ═══════════════════════════════════════════════════════════════════════════════
// AG Sync — Dashboard Webview v2
// Full-featured dashboard with live progress, activity log, machine info
// ═══════════════════════════════════════════════════════════════════════════════

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
            vscode.window.showErrorMessage(`Dashboard error: ${e.message}`);
            sendLog('error', e.message);
        }
    });

    panel.webview.html = getDashboardHtml();
    sendDashboardData(context);
}

/**
 * Send a live log message to the dashboard
 */
function sendLog(level, message) {
    if (!panel) return;
    panel.webview.postMessage({ type: 'log', level, message, timestamp: new Date().toISOString() });
}

/**
 * Send progress update to the dashboard
 */
function sendProgress(percent, message) {
    if (!panel) return;
    panel.webview.postMessage({ type: 'progress', percent, message });
}

/**
 * Set the operation status on the dashboard
 */
function sendOperationStatus(status) {
    // status: 'idle' | 'pushing' | 'pulling' | 'exporting' | 'importing' | 'error' | 'success'
    if (!panel) return;
    panel.webview.postMessage({ type: 'opStatus', status });
}

function lightweightScan() {
    const results = {};
    for (const [catId, catDef] of Object.entries(scanner.CATEGORIES)) {
        let exists = false;
        let itemCount = 0;

        for (const dir of (catDef.dirs || [])) {
            const dirPath = path.join(scanner.AG_ROOT, dir);
            if (fs.existsSync(dirPath)) {
                exists = true;
                try { itemCount += fs.readdirSync(dirPath).length; } catch (e) { }
            }
        }
        for (const file of (catDef.files || [])) {
            if (fs.existsSync(path.join(scanner.AG_ROOT, file))) { exists = true; itemCount++; }
        }
        for (const file of (catDef.parentFiles || [])) {
            if (fs.existsSync(path.join(scanner.GEMINI_ROOT, file))) { exists = true; itemCount++; }
        }

        results[catId] = {
            id: catId, label: catDef.label, description: catDef.description, icon: catDef.icon,
            fileCount: itemCount, totalSizeFormatted: exists ? `${itemCount} items` : 'empty',
            included: true
        };
    }
    return results;
}

async function sendDashboardData(context) {
    if (!panel) return;

    sendLog('info', 'Refreshing dashboard...');

    const state = syncState.loadState();

    let ghAvailable = false, ghUser = null;
    try { ghAvailable = github.isGhCliAvailable(); if (ghAvailable) ghUser = github.getGhUsername(); } catch (e) { }

    let selections = state.categorySelections;
    if (!selections) {
        const excludes = vscode.workspace.getConfiguration('agSync').get('excludeCategories', []);
        selections = scanner.getDefaultSelections(excludes);
    }

    const categories = lightweightScan();
    for (const id of Object.keys(categories)) categories[id].included = selections[id] !== false;

    const machineId = state.machineId || 'unknown';
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const platform = os.platform();

    panel.webview.postMessage({
        type: 'update',
        data: {
            state,
            scan: { categories },
            github: { available: ghAvailable, username: ghUser, repo: state.githubRepo },
            machine: { id: machineId, hostname, username, platform },
            selections
        }
    });

    sendLog('info', 'Dashboard ready.');
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
    --bg: #0a0e14; --card: #131920; --card2: #1a2029; --border: #2a3140;
    --text: #c5cdd8; --dim: #6b7688; --bright: #e8edf3;
    --accent: #4a9eff; --green: #2dd4a8; --red: #f5485b;
    --orange: #f0a43a; --purple: #a78bfa; --cyan: #22d3ee;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Segoe UI',system-ui,sans-serif; background:var(--bg); color:var(--text); padding:0; overflow-x:hidden; }

/* ── Header ─────────────────────────────────────────────────── */
.header { padding:20px 24px 16px; border-bottom:1px solid var(--border); background:linear-gradient(135deg,#0f141c 0%,#0a0e14 100%); }
.header h1 { font-size:22px; color:var(--bright); display:flex; align-items:center; gap:10px; }
.header h1 .logo { font-size:28px; }
.header .sub { color:var(--dim); font-size:12px; margin-top:4px; }

/* ── Layout ─────────────────────────────────────────────────── */
.main { display:grid; grid-template-columns:1fr 340px; gap:0; min-height:calc(100vh - 80px); }
.left { padding:20px 24px; overflow-y:auto; }
.right { border-left:1px solid var(--border); display:flex; flex-direction:column; }

/* ── Cards ──────────────────────────────────────────────────── */
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:16px; }
.card-title { font-size:13px; font-weight:700; color:var(--bright); margin-bottom:12px; display:flex; align-items:center; gap:8px; text-transform:uppercase; letter-spacing:.5px; }
.card-title .icon { font-size:16px; }

/* ── Status Row ─────────────────────────────────────────────── */
.status-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:16px; }
.status-box { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px; text-align:center; }
.status-box .label { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; }
.status-box .val { font-size:18px; font-weight:700; color:var(--bright); margin-top:4px; }
.status-box .val.green { color:var(--green); }
.status-box .val.red { color:var(--red); }
.status-box .val.orange { color:var(--orange); }
.status-box .val.accent { color:var(--accent); }

/* ── Progress Bar ───────────────────────────────────────────── */
.progress-section { margin-bottom:16px; }
.progress-bar-outer { width:100%; height:8px; background:var(--border); border-radius:4px; overflow:hidden; margin-top:8px; }
.progress-bar-inner { height:100%; background:linear-gradient(90deg,var(--accent),var(--green)); border-radius:4px; transition:width .3s ease; width:0%; }
.progress-label { display:flex; justify-content:space-between; align-items:center; }
.progress-label .msg { font-size:12px; color:var(--dim); max-width:70%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.progress-label .pct { font-size:13px; font-weight:700; color:var(--accent); }
.op-badge { display:inline-block; padding:3px 10px; border-radius:6px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
.op-badge.idle { background:rgba(107,118,136,.15); color:var(--dim); }
.op-badge.pushing { background:rgba(74,158,255,.15); color:var(--accent); }
.op-badge.pulling { background:rgba(45,212,168,.15); color:var(--green); }
.op-badge.exporting { background:rgba(167,139,250,.15); color:var(--purple); }
.op-badge.importing { background:rgba(240,164,58,.15); color:var(--orange); }
.op-badge.success { background:rgba(45,212,168,.15); color:var(--green); }
.op-badge.error { background:rgba(245,72,91,.15); color:var(--red); }

/* ── Action Buttons ─────────────────────────────────────────── */
.btn-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.btn { padding:9px 18px; border-radius:8px; border:1px solid var(--border); background:var(--card2); color:var(--text); cursor:pointer; font-size:13px; font-family:inherit; font-weight:600; transition:all .15s; display:inline-flex; align-items:center; gap:6px; }
.btn:hover { background:var(--border); color:var(--bright); transform:translateY(-1px); }
.btn.push { background:rgba(74,158,255,.12); border-color:rgba(74,158,255,.3); color:var(--accent); }
.btn.push:hover { background:rgba(74,158,255,.25); }
.btn.pull { background:rgba(45,212,168,.12); border-color:rgba(45,212,168,.3); color:var(--green); }
.btn.pull:hover { background:rgba(45,212,168,.25); }
.btn.export { background:rgba(167,139,250,.12); border-color:rgba(167,139,250,.3); color:var(--purple); }
.btn.export:hover { background:rgba(167,139,250,.25); }
.btn.import { background:rgba(240,164,58,.12); border-color:rgba(240,164,58,.3); color:var(--orange); }
.btn.import:hover { background:rgba(240,164,58,.25); }
.btn.danger { border-color:rgba(245,72,91,.3); color:var(--red); }
.btn.danger:hover { background:rgba(245,72,91,.15); }

/* ── Category Toggles ───────────────────────────────────────── */
.cat-list { display:flex; flex-direction:column; gap:6px; }
.cat-row { display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:8px; background:var(--card2); border:1px solid transparent; cursor:pointer; transition:all .15s; }
.cat-row:hover { border-color:var(--border); }
.cat-row.off { opacity:.4; }
.cat-sw { width:32px; height:18px; border-radius:9px; background:var(--border); position:relative; transition:.2s; flex-shrink:0; }
.cat-sw.on { background:var(--green); }
.cat-sw::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; transition:.2s; }
.cat-sw.on::after { transform:translateX(14px); }
.cat-label { font-size:13px; font-weight:600; color:var(--bright); flex:1; }
.cat-count { font-size:11px; color:var(--dim); }

/* ── Activity Log (right panel) ─────────────────────────────── */
.log-header { padding:14px 16px; border-bottom:1px solid var(--border); font-size:13px; font-weight:700; color:var(--bright); text-transform:uppercase; letter-spacing:.5px; display:flex; align-items:center; gap:8px; }
.log-body { flex:1; overflow-y:auto; padding:8px; font-family:'Cascadia Code','SF Mono','Fira Code',monospace; font-size:11px; line-height:1.7; max-height:calc(100vh - 130px); }
.log-entry { padding:2px 8px; border-radius:4px; }
.log-entry:hover { background:rgba(255,255,255,.03); }
.log-entry .time { color:var(--dim); margin-right:6px; }
.log-entry.info .msg { color:var(--text); }
.log-entry.success .msg { color:var(--green); }
.log-entry.warn .msg { color:var(--orange); }
.log-entry.error .msg { color:var(--red); }
.log-entry.step .msg { color:var(--accent); }

/* ── Machine Info ───────────────────────────────────────────── */
.machine-bar { display:flex; gap:16px; padding:10px 16px; border-top:1px solid var(--border); font-size:11px; color:var(--dim); align-items:center; }
.machine-bar .tag { background:var(--card2); padding:2px 8px; border-radius:4px; color:var(--text); font-family:monospace; }

/* ── Sync History ───────────────────────────────────────────── */
.hist-item { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(42,49,64,.5); font-size:12px; }
.hist-item:last-child { border-bottom:none; }
.hist-badge { padding:2px 8px; border-radius:4px; font-weight:700; font-size:10px; text-transform:uppercase; min-width:42px; text-align:center; }
.hist-badge.push { background:rgba(74,158,255,.12); color:var(--accent); }
.hist-badge.pull { background:rgba(45,212,168,.12); color:var(--green); }
.hist-time { color:var(--dim); font-size:11px; }
.hist-files { color:var(--text); }
.hist-sha { color:var(--dim); font-family:monospace; font-size:10px; }

.empty { color:var(--dim); font-style:italic; font-size:12px; padding:8px 0; }
</style>
</head>
<body>

<div class="header">
    <h1><span class="logo">&#9889;</span> AG Sync <span class="op-badge idle" id="opBadge">IDLE</span></h1>
    <div class="sub">Export, import, and sync your Antigravity data between machines</div>
</div>

<div class="main">
<div class="left">

    <!-- Status Row -->
    <div class="status-grid">
        <div class="status-box">
            <div class="label">GitHub</div>
            <div class="val" id="ghVal">...</div>
        </div>
        <div class="status-box">
            <div class="label">Sync Repo</div>
            <div class="val accent" id="repoVal" style="font-size:13px">...</div>
        </div>
        <div class="status-box">
            <div class="label">Machine ID</div>
            <div class="val" id="machineVal" style="font-size:13px;font-family:monospace">...</div>
        </div>
    </div>

    <!-- Progress -->
    <div class="progress-section card" id="progressCard" style="display:none">
        <div class="progress-label">
            <span class="msg" id="progressMsg">Ready</span>
            <span class="pct" id="progressPct">0%</span>
        </div>
        <div class="progress-bar-outer">
            <div class="progress-bar-inner" id="progressBar"></div>
        </div>
    </div>

    <!-- Actions -->
    <div class="btn-row">
        <button class="btn push" onclick="post('push')">&#9650; Push to GitHub</button>
        <button class="btn pull" onclick="post('pull')">&#9660; Pull from GitHub</button>
        <button class="btn export" onclick="post('export')">&#128230; Export ZIP</button>
        <button class="btn import" onclick="post('import')">&#128229; Import ZIP</button>
        <button class="btn" onclick="post('connectGithub')">&#128279; GitHub</button>
        <button class="btn" onclick="post('selectRepo')">&#128193; Repo</button>
        <button class="btn" onclick="post('refresh')">&#8635; Refresh</button>
        <button class="btn danger" onclick="post('resetSync')">Reset</button>
    </div>

    <!-- Last Sync Info -->
    <div class="card">
        <div class="card-title">Last Sync</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
            <div><span style="color:var(--dim)">Last Push:</span> <strong id="lastPush">Never</strong></div>
            <div><span style="color:var(--dim)">Last Pull:</span> <strong id="lastPull">Never</strong></div>
            <div><span style="color:var(--dim)">Push Commit:</span> <span id="pushSha" style="font-family:monospace;color:var(--dim)">-</span></div>
            <div><span style="color:var(--dim)">Pull Commit:</span> <span id="pullSha" style="font-family:monospace;color:var(--dim)">-</span></div>
        </div>
    </div>

    <!-- Categories -->
    <div class="card">
        <div class="card-title">Data Categories</div>
        <div class="cat-list" id="catList"></div>
    </div>

    <!-- History -->
    <div class="card">
        <div class="card-title">Sync History</div>
        <div id="histList"><p class="empty">No sync history yet.</p></div>
    </div>

</div>

<!-- Right Panel: Activity Log -->
<div class="right">
    <div class="log-header">&#9632; Activity Log</div>
    <div class="log-body" id="logBody">
        <div class="log-entry info"><span class="time">--:--:--</span><span class="msg">Waiting for data...</span></div>
    </div>
    <div class="machine-bar">
        <span>Machine:</span>
        <span class="tag" id="mHostname">-</span>
        <span class="tag" id="mUser">-</span>
        <span class="tag" id="mPlatform">-</span>
    </div>
</div>
</div>

<script>
const vscode = acquireVsCodeApi();
function post(cmd, data) { vscode.postMessage({ command: cmd, ...data }); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

const logBody = document.getElementById('logBody');
let logCount = 0;

function addLog(level, message, ts) {
    const t = ts ? new Date(ts) : new Date();
    const time = t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const el = document.createElement('div');
    el.className = 'log-entry ' + level;
    el.innerHTML = '<span class="time">' + time + '</span><span class="msg">' + esc(message) + '</span>';
    logBody.prepend(el);
    logCount++;
    if (logCount > 200) { logBody.removeChild(logBody.lastChild); logCount--; }
}

window.addEventListener('message', e => {
    const d = e.data;
    if (d.type === 'update') render(d.data);
    if (d.type === 'log') addLog(d.level, d.message, d.timestamp);
    if (d.type === 'progress') updateProgress(d.percent, d.message);
    if (d.type === 'opStatus') updateOpStatus(d.status);
});

function updateProgress(pct, msg) {
    const card = document.getElementById('progressCard');
    card.style.display = 'block';
    // Auto-parse percentage from message if pct not given
    let percent = pct;
    if ((!percent || percent <= 0) && msg) {
        const m = msg.match(/\((\d+)%\)/);
        if (m) percent = parseInt(m[1]);
    }
    percent = percent || 0;
    document.getElementById('progressBar').style.width = percent + '%';
    document.getElementById('progressPct').textContent = percent + '%';
    document.getElementById('progressMsg').textContent = msg || '';
    if (percent >= 100) {
        setTimeout(() => { card.style.display = 'none'; }, 5000);
    }
}

const opLabels = {
    idle: 'IDLE', pushing: 'PUSHING...', pulling: 'PULLING...',
    exporting: 'EXPORTING...', importing: 'IMPORTING...',
    success: 'DONE', error: 'ERROR'
};
function updateOpStatus(s) {
    const badge = document.getElementById('opBadge');
    badge.className = 'op-badge ' + s;
    badge.textContent = opLabels[s] || s.toUpperCase();
}

function render(d) {
    // GitHub status
    const gh = d.github;
    const ghEl = document.getElementById('ghVal');
    if (gh.available) {
        ghEl.textContent = gh.username || 'Connected';
        ghEl.className = 'val green';
    } else {
        ghEl.textContent = 'Offline';
        ghEl.className = 'val red';
    }

    document.getElementById('repoVal').textContent = gh.repo || 'Auto on first push';
    document.getElementById('machineVal').textContent = d.machine.id;

    // Last sync
    document.getElementById('lastPush').textContent = d.state.lastPushTime ? fmtTime(d.state.lastPushTime) : 'Never';
    document.getElementById('lastPull').textContent = d.state.lastPullTime ? fmtTime(d.state.lastPullTime) : 'Never';
    document.getElementById('pushSha').textContent = d.state.lastPushCommit ? d.state.lastPushCommit.slice(0,7) : '-';
    document.getElementById('pullSha').textContent = d.state.lastPullCommit ? d.state.lastPullCommit.slice(0,7) : '-';

    // Machine info
    document.getElementById('mHostname').textContent = d.machine.hostname;
    document.getElementById('mUser').textContent = d.machine.username;
    document.getElementById('mPlatform').textContent = d.machine.platform;

    // Categories
    const cl = document.getElementById('catList');
    cl.innerHTML = '';
    if (d.scan && d.scan.categories) {
        for (const [id, cat] of Object.entries(d.scan.categories)) {
            const on = cat.included;
            const row = document.createElement('div');
            row.className = 'cat-row' + (on ? '' : ' off');
            row.innerHTML = '<div class="cat-sw ' + (on ? 'on' : '') + '"></div>' +
                '<span class="cat-label">' + esc(cat.label) + '</span>' +
                '<span class="cat-count">' + esc(cat.totalSizeFormatted) + '</span>';
            row.onclick = () => post('toggleCategory', { categoryId: id, enabled: !on });
            cl.appendChild(row);
        }
    }

    // History
    const hl = document.getElementById('histList');
    if (d.state.syncHistory && d.state.syncHistory.length > 0) {
        hl.innerHTML = d.state.syncHistory.slice(0, 20).map(h => {
            let detail = '';
            if (h.added !== undefined) {
                detail = '+' + h.added + ' ~' + h.modified + ' -' + h.deleted;
                if (h.unchanged) detail += ' (' + h.unchanged.toLocaleString() + ' ok)';
            } else {
                detail = (h.filesCount || h.filesImported || 0) + ' files';
            }
            return '<div class="hist-item">' +
                '<span class="hist-badge ' + h.action + '">' + h.action + '</span>' +
                '<span class="hist-time">' + fmtTime(h.timestamp) + '</span>' +
                '<span class="hist-files">' + detail + '</span>' +
                (h.commit ? '<span class="hist-sha">' + h.commit.slice(0,7) + '</span>' : '') +
                '</div>';
        }).join('');
    } else {
        hl.innerHTML = '<p class="empty">No sync history yet. Hit Push to start.</p>';
    }

    addLog('success', 'Dashboard updated');
}

function fmtTime(iso) {
    try {
        const d = new Date(iso), now = new Date(), ms = now - d;
        if (ms < 60000) return 'just now';
        if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
        if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    } catch(e) { return iso; }
}

post('refresh');
addLog('info', 'AG Sync Dashboard v2.0 loaded');
</script>
</body>
</html>`;
}

async function refresh(context) {
    if (panel) await sendDashboardData(context);
}

module.exports = { createOrShow, refresh, sendLog, sendProgress, sendOperationStatus };
