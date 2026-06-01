'use strict';
(() => {

const api = window.api;

const els = {
  edgeTabs: document.getElementById('edgeTabs'),
  sidebar: document.getElementById('sidebar'),
  kpStatus: document.getElementById('kpStatus'),
  kpAssociate: document.getElementById('kpAssociate'),
  aliasEditor: document.getElementById('aliasEditor'),
  aliasRows: document.getElementById('aliasRows'),
  aliasAdd: document.getElementById('aliasAdd'),
  aliasCancel: document.getElementById('aliasCancel'),
  aliasSave: document.getElementById('aliasSave'),
  sessionList: document.getElementById('sessionList'),
  newSession: document.getElementById('newSession'),
  tabs: document.getElementById('tabs'),
  terminal: document.getElementById('terminal'),
  placeholder: document.getElementById('placeholder'),
  // editor
  editor: document.getElementById('editor'),
  editorTitle: document.getElementById('editorTitle'),
  editorSave: document.getElementById('editorSave'),
  editorCancel: document.getElementById('editorCancel'),
  editorDelete: document.getElementById('editorDelete'),
  f: {
    name: document.getElementById('f_name'),
    host: document.getElementById('f_host'),
    port: document.getElementById('f_port'),
    user: document.getElementById('f_user'),
    auth: document.getElementById('f_auth'),
    kpurl: document.getElementById('f_kpurl'),
    keyfield: document.getElementById('f_keyfield'),
    passfield: document.getElementById('f_passfield'),
    agent: document.getElementById('f_agent'),
    jhost: document.getElementById('f_jhost'),
    jport: document.getElementById('f_jport'),
    juser: document.getElementById('f_juser'),
    jauth: document.getElementById('f_jauth'),
    syntax: document.getElementById('f_syntax'),
  },
  tunnelRows: document.getElementById('tunnelRows'),
  tunnelAdd: document.getElementById('tunnelAdd'),
  multiExecBar: document.getElementById('multiExecBar'),
  // macros
  macroEditor: document.getElementById('macroEditor'),
  macroRows: document.getElementById('macroRows'),
  macroAdd: document.getElementById('macroAdd'),
  macroCancel: document.getElementById('macroCancel'),
  macroSave: document.getElementById('macroSave'),
  // settings
  settingsEditor: document.getElementById('settingsEditor'),
  setDataDir: document.getElementById('set_dataDir'),
  setDataBrowse: document.getElementById('set_dataBrowse'),
  setDataMove: document.getElementById('set_dataMove'),
  setSyntax: document.getElementById('set_syntax'),
  setMsg: document.getElementById('set_msg'),
  setCancel: document.getElementById('set_cancel'),
  setSave: document.getElementById('set_save'),
  // remote file editor
  fileEditor: document.getElementById('fileEditor'),
  fileEditorTitle: document.getElementById('fileEditorTitle'),
  fileEditorText: document.getElementById('fileEditorText'),
  fileEditorMsg: document.getElementById('fileEditorMsg'),
  fileEditorCancel: document.getElementById('fileEditorCancel'),
  fileEditorSave: document.getElementById('fileEditorSave'),
  // sftp
  sftpPanel: document.getElementById('sftpPanel'),
  sftpPath: document.getElementById('sftpPath'),
  sftpList: document.getElementById('sftpList'),
  sftpUp: document.getElementById('sftpUp'),
  sftpHome: document.getElementById('sftpHome'),
  sftpRefresh: document.getElementById('sftpRefresh'),
  sftpMkdir: document.getElementById('sftpMkdir'),
  sftpUpload: document.getElementById('sftpUpload'),
  sftpDownload: document.getElementById('sftpDownload'),
  sftpDelete: document.getElementById('sftpDelete'),
  sftpFollow: document.getElementById('sftpFollow'),
  sftpHint: document.getElementById('sftpHint'),
  sftpDrop: document.getElementById('sftpDrop'),
  sftpXfers: document.getElementById('sftpXfers'),
  ctxMenu: document.getElementById('ctxMenu'),
};

let sessions = [];
let activeId = null;
let editingId = null;
const terms = new Map();   // sessionId -> { term, fit, el, ready }
let sftpSessionId = null;
let sftpDir = null;
let sftpItems = [];               // current dir entries (from server)
const sftpSelected = new Set();   // selected item names
let lastClickIdx = -1;            // anchor for shift-select
let sftpHomeDir = null;           // first resolved dir, used by the Home button
let followTerminal = false;       // mirror the shell's cwd (via OSC 7)
let currentPane = 'sessions';     // active left pane: 'sessions' | 'sftp'
const autoShownSftp = new Set();  // sessions whose browser auto-popped once
let multiExec = false;            // broadcast keystrokes to all sessions
let settings = { syntaxHighlight: true };
let fileEditPath = null;          // remote path open in the file editor

// --- KeePass status --------------------------------------------------------

async function refreshKpStatus() {
  try {
    const r = await api.keepassStatus();
    if (r.ok) {
      els.kpStatus.textContent = 'KeePassXC: connected';
      els.kpStatus.className = 'kp-status ok';
      els.kpAssociate.classList.add('hidden');
    } else {
      els.kpStatus.textContent = 'KeePassXC: ' + r.error;
      els.kpStatus.className = 'kp-status err';
      els.kpAssociate.classList.remove('hidden');
    }
  } catch (e) {
    els.kpStatus.textContent = 'KeePassXC: status check failed (' + e.message + ')';
    els.kpStatus.className = 'kp-status err';
  }
}

async function doAssociate() {
  els.kpStatus.textContent = 'KeePassXC: pairing… (confirm in KeePassXC)';
  const r = await api.keepassAssociate();
  if (!r.ok) alert('Pairing failed: ' + r.error);
  refreshKpStatus();
}
els.kpAssociate.addEventListener('click', doAssociate);
api.onMenuPair(doAssociate);

// --- sessions list ---------------------------------------------------------

async function loadSessions() {
  sessions = await api.listSessions();
  renderSessions();
}

function renderSessions() {
  els.sessionList.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    if (s.id === activeId) li.classList.add('active');
    li.innerHTML =
      `<span><b>${esc(s.name || s.host)}</b> <span class="edit" data-edit="${s.id}">✎</span></span>` +
      `<span class="host">${esc(s.username || '')}@${esc(s.host)}:${esc(String(s.port || 22))}</span>`;
    li.addEventListener('click', (e) => {
      if (e.target.dataset.edit) { openEditor(s.id); return; }
      openSession(s.id);
    });
    els.sessionList.appendChild(li);
  }
}

// --- session editor --------------------------------------------------------

function syncAuthFields() {
  const v = els.f.auth.value;
  els.editor.querySelector('.auth-keepass').classList.toggle('hidden', v === 'agent');
  els.editor.querySelector('.auth-key').classList.toggle('hidden', v !== 'keepass-key');
  els.editor.querySelector('.auth-agent').classList.toggle('hidden', v !== 'agent');
}
els.f.auth.addEventListener('change', syncAuthFields);

function openEditor(id) {
  editingId = id || null;
  const s = sessions.find((x) => x.id === id) || {};
  els.editorTitle.textContent = id ? 'Edit session' : 'New session';
  els.f.name.value = s.name || '';
  els.f.host.value = s.host || '';
  els.f.port.value = s.port || 22;
  els.f.user.value = s.username || '';
  els.f.auth.value = s.auth || 'keepass-password';
  els.f.kpurl.value = s.keepassUrl || '';
  els.f.keyfield.value = s.keyField || 'privateKey';
  els.f.passfield.value = s.passphraseField || '';
  els.f.agent.value = s.agentPath || '';
  els.f.jhost.value = s.jumpHost || '';
  els.f.jport.value = s.jumpPort || 22;
  els.f.juser.value = s.jumpUsername || '';
  els.f.jauth.value = s.jumpAuth || 'agent';
  els.f.syntax.value = s.syntaxHighlight || 'default';
  document.getElementById('f_kppass').value = '';
  renderTunnelRows(s.tunnels || []);
  els.editorDelete.classList.toggle('hidden', !id);
  syncAuthFields();
  els.editor.classList.remove('hidden');
}

function addTunnelRow(t) {
  t = t || {};
  const row = document.createElement('div');
  row.className = 'tunnel-row';
  row.innerHTML =
    `<select class="t-type">
       <option value="local">Local</option>
       <option value="remote">Remote</option>
     </select>` +
    `<input class="t-src" placeholder="src port" />` +
    `<span class="t-arrow">→</span>` +
    `<input class="t-dhost" placeholder="dst host" />` +
    `<input class="t-dport" placeholder="dst port" />` +
    `<button class="ic t-del" type="button" title="Remove">✕</button>`;
  row.querySelector('.t-type').value = t.type || 'local';
  row.querySelector('.t-src').value = t.srcPort || '';
  row.querySelector('.t-dhost').value = t.dstHost || '';
  row.querySelector('.t-dport').value = t.dstPort || '';
  row.querySelector('.t-del').addEventListener('click', () => row.remove());
  els.tunnelRows.appendChild(row);
}

function renderTunnelRows(tunnels) {
  els.tunnelRows.innerHTML = '';
  tunnels.forEach(addTunnelRow);
}

function collectTunnels() {
  const out = [];
  for (const row of els.tunnelRows.querySelectorAll('.tunnel-row')) {
    const t = {
      type: row.querySelector('.t-type').value,
      srcPort: Number(row.querySelector('.t-src').value) || 0,
      dstHost: row.querySelector('.t-dhost').value.trim(),
      dstPort: Number(row.querySelector('.t-dport').value) || 0,
    };
    if (t.srcPort && t.dstHost && t.dstPort) out.push(t);
  }
  return out;
}
els.tunnelAdd.addEventListener('click', () => addTunnelRow());

els.newSession.addEventListener('click', () => openEditor(null));
els.editorCancel.addEventListener('click', () => els.editor.classList.add('hidden'));

// Create/update a KeePassXC entry from the username + a typed password.
document.getElementById('kpCreateEntry').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const host = els.f.host.value.trim();
  const login = els.f.user.value.trim();
  const password = document.getElementById('f_kppass').value;
  const url = els.f.kpurl.value.trim() || (host ? 'ssh://' + host : '');
  if (!url) { alert('Enter a host (or KeePass match URL) first.'); return; }
  if (!login) { alert('Enter a username first.'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  const r = await api.keepassSetLogin(url, login, password);
  btn.disabled = false; btn.textContent = 'Save credentials to KeePassXC';
  if (r.ok) {
    document.getElementById('f_kppass').value = '';
    alert('Saved to KeePassXC: ' + login + ' @ ' + url);
  } else {
    alert('Could not save to KeePassXC: ' + r.error);
  }
});

els.editorSave.addEventListener('click', async () => {
  const s = {
    id: editingId || undefined,
    name: els.f.name.value.trim(),
    host: els.f.host.value.trim(),
    port: Number(els.f.port.value) || 22,
    username: els.f.user.value.trim(),
    auth: els.f.auth.value,
    keepassUrl: els.f.kpurl.value.trim(),
    keyField: els.f.keyfield.value.trim(),
    passphraseField: els.f.passfield.value.trim(),
    agentPath: els.f.agent.value.trim(),
    jumpHost: els.f.jhost.value.trim(),
    jumpPort: Number(els.f.jport.value) || 22,
    jumpUsername: els.f.juser.value.trim(),
    jumpAuth: els.f.jauth.value,
    syntaxHighlight: els.f.syntax.value,
    tunnels: collectTunnels(),
  };
  if (!s.host) { alert('Host is required.'); return; }
  await api.saveSession(s);
  els.editor.classList.add('hidden');
  await loadSessions();
});

els.editorDelete.addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Delete this session?')) return;
  await api.deleteSession(editingId);
  els.editor.classList.add('hidden');
  await loadSessions();
});

// --- global aliases --------------------------------------------------------

function addAliasRow(alias) {
  const row = document.createElement('div');
  row.className = 'alias-row';
  row.innerHTML =
    `<input class="a-name" placeholder="ll" />` +
    `<span class="a-arrow">→</span>` +
    `<input class="a-cmd" placeholder="ls -alF" />` +
    `<button class="ic a-del" title="Remove">✕</button>`;
  row.querySelector('.a-name').value = (alias && alias.name) || '';
  row.querySelector('.a-cmd').value = (alias && alias.command) || '';
  row.querySelector('.a-del').addEventListener('click', () => row.remove());
  els.aliasRows.appendChild(row);
}

async function openAliasEditor() {
  const aliases = await api.listAliases();
  els.aliasRows.innerHTML = '';
  if (aliases.length) aliases.forEach(addAliasRow);
  else addAliasRow();
  els.aliasEditor.classList.remove('hidden');
}

api.onMenuAliases(openAliasEditor);
els.aliasAdd.addEventListener('click', () => addAliasRow());
els.aliasCancel.addEventListener('click', () => els.aliasEditor.classList.add('hidden'));
els.aliasSave.addEventListener('click', async () => {
  const aliases = [];
  for (const row of els.aliasRows.querySelectorAll('.alias-row')) {
    aliases.push({
      name: row.querySelector('.a-name').value.trim(),
      command: row.querySelector('.a-cmd').value.trim(),
    });
  }
  await api.saveAliases(aliases);
  els.aliasEditor.classList.add('hidden');
});

// --- macros ----------------------------------------------------------------

function addMacroRow(macro) {
  macro = macro || {};
  const row = document.createElement('div');
  row.className = 'macro-row';
  row.dataset.id = macro.id || '';
  row.innerHTML =
    `<div class="macro-row-head">` +
    `  <input class="m-name" placeholder="Macro name" />` +
    `  <button class="ic m-del" type="button" title="Remove">✕</button>` +
    `</div>` +
    `<textarea class="m-script code" rows="3" spellcheck="false" placeholder="commands to send…"></textarea>`;
  row.querySelector('.m-name').value = macro.name || '';
  row.querySelector('.m-script').value = macro.script || '';
  row.querySelector('.m-del').addEventListener('click', () => row.remove());
  els.macroRows.appendChild(row);
}

async function openMacroEditor() {
  const macros = await api.listMacros();
  els.macroRows.innerHTML = '';
  if (macros.length) macros.forEach(addMacroRow);
  else addMacroRow();
  els.macroEditor.classList.remove('hidden');
}

api.onMenuMacros(openMacroEditor);
els.macroAdd.addEventListener('click', () => addMacroRow());
els.macroCancel.addEventListener('click', () => els.macroEditor.classList.add('hidden'));
els.macroSave.addEventListener('click', async () => {
  const macros = [];
  for (const row of els.macroRows.querySelectorAll('.macro-row')) {
    macros.push({
      id: row.dataset.id || undefined,
      name: row.querySelector('.m-name').value.trim(),
      script: row.querySelector('.m-script').value,
    });
  }
  await api.saveMacros(macros);
  els.macroEditor.classList.add('hidden');
});

// Run a macro (by id) against the active session.
api.onMenuRunMacro(async (id) => {
  if (!activeId) { alert('No active session.'); return; }
  const t = terms.get(activeId);
  if (!t || !t.ready) { alert('Active session is not connected.'); return; }
  const macros = await api.listMacros();
  const m = macros.find((x) => x.id === id);
  if (!m) return;
  const script = m.script.endsWith('\n') ? m.script : m.script + '\n';
  api.sshInput(activeId, script);
  t.term.focus();
});

// --- remote file editor ----------------------------------------------------

async function openFileEditor(item) {
  if (item.size > 2 * 1024 * 1024 &&
      !confirm(`"${item.name}" is ${fmtSize(item.size)}. Open in the editor anyway?`)) return;
  const remotePath = remotePathOf(item.name);
  els.fileEditorTitle.textContent = 'Edit — ' + remotePath;
  els.fileEditorText.value = 'Loading…';
  els.fileEditorText.disabled = true;
  els.fileEditorMsg.textContent = '';
  els.fileEditor.classList.remove('hidden');
  const r = await api.sftpReadFile(sftpSessionId, remotePath);
  if (!r.ok) { els.fileEditor.classList.add('hidden'); alert('Open failed: ' + r.error); return; }
  fileEditPath = remotePath;
  els.fileEditorText.value = r.content;
  els.fileEditorText.disabled = false;
  els.fileEditorText.focus();
}

els.fileEditorCancel.addEventListener('click', () => {
  els.fileEditor.classList.add('hidden');
  fileEditPath = null;
});
els.fileEditorSave.addEventListener('click', async () => {
  if (!fileEditPath) return;
  els.fileEditorMsg.textContent = 'Saving…';
  const r = await api.sftpWriteFile(sftpSessionId, fileEditPath, els.fileEditorText.value);
  if (!r.ok) { els.fileEditorMsg.textContent = 'Failed: ' + r.error; return; }
  els.fileEditorMsg.textContent = 'Saved.';
  setTimeout(() => { els.fileEditorMsg.textContent = ''; }, 1500);
});

// --- terminals + tabs ------------------------------------------------------

function ensureTerm(sessionId) {
  if (terms.has(sessionId)) return terms.get(sessionId);
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
  if (!TerminalCtor || !FitAddonCtor) {
    throw new Error('xterm.js failed to load. Did "npm install" run? Check the DevTools console.');
  }
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;padding:6px;display:none;';
  els.terminal.appendChild(el);
  const term = new TerminalCtor({
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    theme: { background: '#000000' },
    cursorBlink: true,
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);
  term.open(el);
  term.onData((d) => {
    if (multiExec && sessionId === activeId) {
      // broadcast to every connected session
      for (const [id, t] of terms) if (t.ready) api.sshInput(id, d);
    } else {
      api.sshInput(sessionId, d);
    }
  });
  term.onResize(({ cols, rows }) => api.sshResize(sessionId, cols, rows));
  // OSC 7: shells that emit `file://host/path` let the browser follow cwd.
  term.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (m && followTerminal && sessionId === activeId && sftpSessionId === sessionId) {
      let p; try { p = decodeURIComponent(m[1]); } catch (_) { p = m[1]; }
      if (p && p !== sftpDir) loadSftp(p);
    }
    return false;
  });
  const entry = { term, fit, el, ready: false };
  terms.set(sessionId, entry);
  return entry;
}

async function openSession(sessionId) {
  els.placeholder.classList.add('hidden');
  try {
    ensureTerm(sessionId);
  } catch (e) {
    els.placeholder.classList.remove('hidden');
    els.placeholder.textContent = e.message;
    return;
  }
  setActive(sessionId);
  const r = await api.sshConnect(sessionId);
  if (!r.ok) {
    terms.get(sessionId).term.writeln('\r\n\x1b[31m' + r.error + '\x1b[0m');
  }
  renderTabs();
}

function setActive(sessionId) {
  activeId = sessionId;
  for (const [id, t] of terms) t.el.style.display = id === sessionId ? 'block' : 'none';
  const t = terms.get(sessionId);
  if (t) { setTimeout(() => { t.fit.fit(); t.term.focus(); }, 0); }
  renderSessions();
  renderTabs();
  syncSftp();
}

function renderTabs() {
  els.tabs.innerHTML = '';
  for (const [id] of terms) {
    const s = sessions.find((x) => x.id === id);
    const t = terms.get(id);
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === activeId ? ' active' : '');
    tab.innerHTML =
      `<span class="dot ${t.ready ? 'ready' : ''}"></span>` +
      `<span>${esc(s ? (s.name || s.host) : id)}</span>` +
      `<span class="x" data-close="${id}" title="Close">✕</span>`;
    tab.addEventListener('click', (e) => {
      if (e.target.dataset.close) { closeTab(id); return; }
      setActive(id);
    });
    els.tabs.appendChild(tab);
  }
}

async function closeTab(id) {
  await api.sshDisconnect(id);
  const t = terms.get(id);
  if (t) { t.term.dispose(); t.el.remove(); terms.delete(id); }
  sftpDirBySession.delete(id);
  sftpHomeBySession.delete(id);
  autoShownSftp.delete(id);
  if (activeId === id) {
    const next = terms.keys().next().value || null;
    activeId = next;
    if (next) setActive(next);
    else {
      els.placeholder.classList.remove('hidden');
      renderTabs(); renderSessions(); syncSftp(); setPane('sessions');
    }
  } else { renderTabs(); }
}

// --- ssh events ------------------------------------------------------------

api.onSshData(({ sessionId, data }) => {
  const t = terms.get(sessionId);
  if (t) t.term.write(highlightEnabled(sessionId) ? highlight(data) : data);
});

// Per-session resolution: session override 'on'/'off' wins over global setting.
function highlightEnabled(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  const mode = (s && s.syntaxHighlight) || 'default';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return settings.syntaxHighlight !== false;
}

// Lightweight keyword coloring. Skips chunks that already carry ANSI escapes
// (e.g. ls/grep color, prompts) to avoid corrupting existing sequences.
const HL = [
  [/\b(ERROR|ERR|FATAL|CRITICAL|FAIL(?:ED|URE)?|DENIED|REFUSED)\b/g, '31'], // red
  [/\b(WARN(?:ING)?|CAUTION)\b/g, '33'],                                    // yellow
  [/\b(OK|SUCCESS|PASSED|DONE|READY|ACTIVE|RUNNING)\b/g, '32'],             // green
];
function highlight(data) {
  if (data.indexOf('\x1b') !== -1) return data; // already styled, leave alone
  let out = data;
  for (const [re, code] of HL) out = out.replace(re, `\x1b[${code}m$1\x1b[39m`);
  return out;
}

api.onSshStatus(({ sessionId, state, error }) => {
  const t = terms.get(sessionId);
  if (!t) return;
  if (state === 'ready') { t.ready = true; t.fit.fit(); }
  if (state === 'closed') { t.ready = false; t.term.writeln('\r\n\x1b[33m[connection closed]\x1b[0m'); }
  if (state === 'error') { t.ready = false; t.term.writeln('\r\n\x1b[31m[error] ' + error + '\x1b[0m'); }
  renderTabs();
  if (sessionId === activeId) {
    syncSftp();
    // the SFTP browser pops up on connect (once per session)
    if (state === 'ready' && !autoShownSftp.has(sessionId)) {
      autoShownSftp.add(sessionId);
      setPane('sftp');
    }
  }
});

// edge tabs: switch the left pane
els.edgeTabs.addEventListener('click', (e) => {
  const b = e.target.closest('.edge-tab');
  if (b) setPane(b.dataset.pane);
});

// --- multi-exec / settings / tunnels --------------------------------------

api.onMenuMultiexec(() => {
  multiExec = !multiExec;
  els.multiExecBar.classList.toggle('hidden', !multiExec);
  refitActive();
});

api.onSettingsChanged((s) => {
  settings = s;
  els.setSyntax.checked = settings.syntaxHighlight !== false;
});

// --- settings dialog -------------------------------------------------------

async function openSettings() {
  const cfg = await api.configGet();
  els.setDataDir.value = cfg.dataDir;
  els.setDataDir.dataset.default = cfg.default;
  els.setDataMove.checked = true;
  els.setSyntax.checked = settings.syntaxHighlight !== false;
  els.setMsg.textContent = '';
  els.settingsEditor.classList.remove('hidden');
}

api.onMenuSettings(openSettings);
els.setDataBrowse.addEventListener('click', async () => {
  const dir = await api.configPickDir();
  if (dir) els.setDataDir.value = dir;
});
els.setCancel.addEventListener('click', () => els.settingsEditor.classList.add('hidden'));
els.setSave.addEventListener('click', async () => {
  els.setMsg.textContent = 'Saving…';
  settings = await api.saveSettings({ syntaxHighlight: els.setSyntax.checked });
  const r = await api.configSetDir(els.setDataDir.value, els.setDataMove.checked);
  if (!r.ok) { els.setMsg.textContent = 'Data dir failed: ' + r.error; return; }
  els.settingsEditor.classList.add('hidden');
  await loadSessions(); // reload from the (possibly new) location
});

api.onTunnelError(({ sessionId, error }) => {
  const t = terms.get(sessionId);
  if (t) t.term.writeln(`\r\n\x1b[31m[tunnel] ${error}\x1b[0m`);
});

window.addEventListener('resize', () => {
  const t = terms.get(activeId);
  if (t) t.fit.fit();
});

// --- sftp -----------------------------------------------------------------

const sftpDirBySession = new Map(); // sessionId -> last browsed dir
const sftpHomeBySession = new Map(); // sessionId -> first resolved dir

// Switch the left panel between the Sessions tree and the Sftp browser.
function setPane(pane) {
  currentPane = pane;
  els.sidebar.classList.toggle('pane-hidden', pane !== 'sessions');
  els.sftpPanel.classList.toggle('pane-hidden', pane !== 'sftp');
  for (const b of els.edgeTabs.querySelectorAll('.edge-tab')) {
    b.classList.toggle('active', b.dataset.pane === pane);
  }
  refitActive();
}

// Bind the Sftp browser to whatever session is active. Auto-loads when that
// session is connected; shows a hint otherwise.
function syncSftp() {
  hideCtx();
  const t = terms.get(activeId);
  const ready = t && t.ready;
  if (!ready) {
    sftpSessionId = null;
    sftpItems = [];
    sftpSelected.clear();
    els.sftpList.innerHTML = '';
    els.sftpPath.textContent = '';
    els.sftpHint.classList.remove('hidden');
    els.sftpHint.textContent = t ? 'Connecting…' : 'Connect a session to browse files.';
    updateToolbar();
    return;
  }
  els.sftpHint.classList.add('hidden');
  sftpSessionId = activeId;
  sftpHomeDir = sftpHomeBySession.get(activeId) || null;
  loadSftp(sftpDirBySession.get(activeId) || null);
}

function refitActive() {
  const t = terms.get(activeId);
  if (t) setTimeout(() => t.fit.fit(), 0);
}

function remotePathOf(name) {
  return sftpDir.replace(/\/$/, '') + '/' + name;
}

async function loadSftp(dir) {
  if (!sftpSessionId) return;
  const sid = sftpSessionId;
  const r = await api.sftpList(sid, dir);
  if (sid !== sftpSessionId) return; // active session changed mid-request
  if (!r.ok) { els.sftpHint.classList.add('hidden'); els.sftpList.innerHTML = `<li class="msg">${esc(r.error)}</li>`; return; }
  sftpDir = r.dir;
  sftpDirBySession.set(sid, r.dir);
  if (!sftpHomeBySession.has(sid)) sftpHomeBySession.set(sid, r.dir);
  sftpHomeDir = sftpHomeBySession.get(sid);
  sftpItems = r.items;
  sftpSelected.clear();
  lastClickIdx = -1;
  els.sftpHint.classList.add('hidden');
  els.sftpPath.textContent = r.dir;
  els.sftpPath.title = r.dir;
  renderSftpList();
}

function renderSftpList() {
  els.sftpList.innerHTML = '';
  sftpItems.forEach((it, idx) => {
    const li = document.createElement('li');
    li.dataset.idx = String(idx);
    if (sftpSelected.has(it.name)) li.classList.add('sel');
    const icon = it.isDir ? '📁' : '📄';
    li.innerHTML = `<span class="ic">${icon}</span><span class="nm">${esc(it.name)}</span>` +
      (it.isDir ? '' : `<span class="size">${fmtSize(it.size)}</span>`);
    li.addEventListener('click', (e) => onItemClick(e, idx));
    li.addEventListener('dblclick', () => onItemOpen(idx));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sftpSelected.has(it.name)) { selectOnly(idx); }
      showCtx(e.clientX, e.clientY);
    });
    els.sftpList.appendChild(li);
  });
  updateToolbar();
}

function selectOnly(idx) {
  sftpSelected.clear();
  sftpSelected.add(sftpItems[idx].name);
  lastClickIdx = idx;
  renderSftpList();
}

function onItemClick(e, idx) {
  const it = sftpItems[idx];
  if (e.shiftKey && lastClickIdx >= 0) {
    const [a, b] = [lastClickIdx, idx].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) sftpSelected.clear();
    for (let i = a; i <= b; i++) sftpSelected.add(sftpItems[i].name);
  } else if (e.ctrlKey || e.metaKey) {
    if (sftpSelected.has(it.name)) sftpSelected.delete(it.name);
    else sftpSelected.add(it.name);
    lastClickIdx = idx;
  } else {
    sftpSelected.clear();
    sftpSelected.add(it.name);
    lastClickIdx = idx;
  }
  renderSftpList();
}

// Double-click: enter directory, or open a file in the editor.
function onItemOpen(idx) {
  const it = sftpItems[idx];
  if (it.isDir) loadSftp(remotePathOf(it.name));
  else openFileEditor(it);
}

function selectedItems() {
  return sftpItems.filter((it) => sftpSelected.has(it.name));
}

function updateToolbar() {
  const conn = !!sftpSessionId;
  const n = sftpSelected.size;
  els.sftpDownload.disabled = !conn || n === 0;
  els.sftpDelete.disabled = !conn || n === 0;
  for (const b of [els.sftpUp, els.sftpHome, els.sftpRefresh, els.sftpMkdir, els.sftpUpload]) {
    b.disabled = !conn;
  }
}

async function downloadItems(items) {
  if (!items.length) return;
  const payload = items.map((it) => ({
    remotePath: remotePathOf(it.name), name: it.name, size: it.size, isDir: it.isDir,
  }));
  const r = await api.sftpDownload(sftpSessionId, payload);
  if (!r.ok && !r.canceled) alert('Download failed: ' + r.error);
}

async function deleteItems(items) {
  if (!items.length) return;
  const names = items.map((i) => i.name).join(', ');
  if (!confirm(`Delete ${items.length} item(s)?\n${names}`)) return;
  const payload = items.map((it) => ({ path: remotePathOf(it.name), isDir: it.isDir }));
  const r = await api.sftpDelete(sftpSessionId, payload);
  if (!r.ok) alert('Delete failed: ' + r.error);
  loadSftp(sftpDir);
}

async function renameItem(it) {
  const next = prompt('Rename to:', it.name);
  if (!next || next === it.name) return;
  const r = await api.sftpRename(sftpSessionId, remotePathOf(it.name), remotePathOf(next));
  if (!r.ok) alert('Rename failed: ' + r.error);
  loadSftp(sftpDir);
}

async function mkdirHere() {
  const name = prompt('New folder name:');
  if (!name) return;
  const r = await api.sftpMkdir(sftpSessionId, sftpDir, name);
  if (!r.ok) alert('Create folder failed: ' + r.error);
  loadSftp(sftpDir);
}

// --- sftp toolbar ----------------------------------------------------------

els.sftpUp.addEventListener('click', () => {
  if (!sftpDir) return;
  const parent = sftpDir.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  loadSftp(parent);
});
els.sftpHome.addEventListener('click', () => loadSftp(sftpHomeDir || null));
els.sftpRefresh.addEventListener('click', () => loadSftp(sftpDir));
els.sftpMkdir.addEventListener('click', mkdirHere);
els.sftpUpload.addEventListener('click', async () => {
  const r = await api.sftpUpload(sftpSessionId, sftpDir);
  if (r.ok) loadSftp(sftpDir);
  else if (!r.canceled) alert('Upload failed: ' + r.error);
});
els.sftpDownload.addEventListener('click', () => downloadItems(selectedItems()));
els.sftpDelete.addEventListener('click', () => deleteItems(selectedItems()));
els.sftpFollow.addEventListener('change', () => { followTerminal = els.sftpFollow.checked; });

// --- sftp drag-and-drop upload (from OS) -----------------------------------

let dragDepth = 0;
function showDrop(on) { els.sftpDrop.classList.toggle('hidden', !on); }

els.sftpPanel.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragDepth++; showDrop(true);
  }
});
els.sftpPanel.addEventListener('dragover', (e) => { e.preventDefault(); });
els.sftpPanel.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; showDrop(false); }
});
els.sftpPanel.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0; showDrop(false);
  if (!sftpSessionId || !e.dataTransfer) return;
  const paths = Array.from(e.dataTransfer.files)
    .map((f) => api.getPathForFile(f))
    .filter(Boolean);
  if (!paths.length) return;
  const r = await api.sftpUploadPaths(sftpSessionId, sftpDir, paths);
  if (r.ok) loadSftp(sftpDir);
  else if (!r.canceled) alert('Upload failed: ' + r.error);
});

// --- sftp context menu -----------------------------------------------------

function showCtx(x, y) {
  const m = els.ctxMenu;
  m.classList.remove('hidden');
  // clamp to viewport
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
}
function hideCtx() { els.ctxMenu.classList.add('hidden'); }

els.ctxMenu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  hideCtx();
  const sel = selectedItems();
  if (act === 'edit') { if (sel.length === 1 && !sel[0].isDir) openFileEditor(sel[0]); }
  else if (act === 'download') downloadItems(sel);
  else if (act === 'rename') { if (sel.length === 1) renameItem(sel[0]); }
  else if (act === 'delete') deleteItems(sel);
  else if (act === 'mkdir') mkdirHere();
  else if (act === 'refresh') loadSftp(sftpDir);
});
document.addEventListener('click', (e) => {
  if (!els.ctxMenu.contains(e.target)) hideCtx();
});
window.addEventListener('blur', hideCtx);

// --- sftp transfer progress ------------------------------------------------

const xfers = new Map(); // id -> { name, dir, total, transferred, state }

api.onSftpProgress((p) => {
  xfers.set(p.id, p);
  renderXfers();
  // auto-clear finished transfers after a short delay
  if (p.state === 'done' || p.state === 'error') {
    setTimeout(() => { xfers.delete(p.id); renderXfers(); }, p.state === 'error' ? 6000 : 2500);
  }
});

function renderXfers() {
  if (xfers.size === 0) { els.sftpXfers.classList.add('hidden'); els.sftpXfers.innerHTML = ''; return; }
  els.sftpXfers.classList.remove('hidden');
  els.sftpXfers.innerHTML = '';
  for (const x of xfers.values()) {
    const pct = x.total ? Math.min(100, Math.round((x.transferred / x.total) * 100)) : 0;
    const arrow = x.dir === 'up' ? '↑' : '↓';
    const row = document.createElement('div');
    row.className = 'xfer' + (x.state === 'error' ? ' err' : '') + (x.state === 'done' ? ' done' : '');
    const label = x.state === 'error'
      ? `${arrow} ${esc(x.name)} — ${esc(x.error || 'failed')}`
      : `${arrow} ${esc(x.name)} — ${fmtSize(x.transferred || 0)}${x.total ? ' / ' + fmtSize(x.total) : ''} (${pct}%)`;
    row.innerHTML =
      `<div class="bar"><div class="fill" style="width:${pct}%"></div></div>` +
      `<div class="lbl">${label}</div>`;
    els.sftpXfers.appendChild(row);
  }
}

// --- helpers ---------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// --- boot ------------------------------------------------------------------

if (!api) {
  els.kpStatus.textContent = 'Preload bridge missing (window.api undefined).';
  els.kpStatus.className = 'kp-status err';
} else {
  refreshKpStatus();
  loadSessions();
  api.getSettings().then((s) => { settings = s; }).catch(() => {});
}

})();
