'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const { KeePassConnection, readStringField } = require('./keepass');
const ssh = require('./ssh');
const { makeStore } = require('./sessions');

let store;
let win;
const active = new Map(); // sessionId -> { conn, stream }

// The data directory holding all JSON files is configurable. A tiny bootstrap
// file in the fixed Electron userData dir records the chosen location; when
// absent, data lives in userData itself (the default).
let bootstrapDir = '';
function locationFile() { return path.join(bootstrapDir, 'location.json'); }
function dataDir() {
  try {
    const l = JSON.parse(fs.readFileSync(locationFile(), 'utf8'));
    if (l && l.dataDir && l.dataDir.trim()) return l.dataDir.trim();
  } catch (_) {}
  return bootstrapDir;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Application menu. Tools → alias manager / KeePassXC pairing are routed to
// the renderer via IPC so they open the existing in-window dialogs.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (ch, ...args) => () => { if (win) win.webContents.send(ch, ...args); };

  const macroItems = store.listMacros().map((m) => ({
    label: m.name, click: send('menu:runMacro', m.id),
  }));
  const syntaxOn = store.getSettings().syntaxHighlight !== false;

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', role: 'editMenu' },
    {
      label: 'Tools',
      submenu: [
        { label: 'Manage Aliases…', click: send('menu:aliases') },
        {
          label: 'Macros',
          submenu: [
            { label: 'Manage Macros…', click: send('menu:macros') },
            { type: 'separator' },
            ...(macroItems.length ? macroItems : [{ label: '(no macros)', enabled: false }]),
          ],
        },
        {
          label: 'Multi-exec mode',
          type: 'checkbox',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: send('menu:multiexec'),
        },
        { type: 'separator' },
        {
          label: 'Syntax highlighting (global)',
          type: 'checkbox',
          checked: syntaxOn,
          click: () => {
            const next = store.saveSettings({ syntaxHighlight: !syntaxOn });
            if (win) win.webContents.send('settings:changed', next);
            buildMenu();
          },
        },
        { type: 'separator' },
        { label: 'Settings…', click: send('menu:settings') },
        { label: 'Pair with KeePassXC', click: send('menu:pair') },
      ],
    },
    { label: 'View', role: 'viewMenu' },
    { role: 'window', submenu: [{ role: 'minimize' }, ...(isMac ? [] : [{ role: 'close' }])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- KeePassXC: connect + (re)associate -----------------------------------

// Open a fresh KeePassXC connection, restoring or creating an association.
async function kpConnect({ allowAssociate = true } = {}) {
  const kp = new KeePassConnection();
  await kp.connect();

  const saved = store.getAssociation();
  if (saved) {
    kp.loadAssociation(saved.id, saved.idPublicKey);
    if (await kp.testAssociate(true)) return kp;
  }
  if (!allowAssociate) {
    kp.close();
    throw new Error('Not associated with KeePassXC yet.');
  }
  const assoc = await kp.associate(); // shows pairing dialog in KeePassXC
  store.saveAssociation(assoc);
  return kp;
}

// Resolve credentials for a session into an ssh2 connect config.
async function resolveAuth(session) {
  const base = { host: session.host, port: Number(session.port) || 22 };

  if (session.auth === 'agent') {
    const agent = session.agentPath ||
      (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK);
    if (!agent) throw new Error('No SSH agent path available.');
    return { ...base, username: session.username, agent };
  }

  // keepass-password / keepass-key both need a lookup. The browser protocol
  // matches ONLY on the entry URL (never on custom fields), so derive an
  // ssh:// URL from the host. KeePassXC matches non-http(s) schemes fine as
  // long as both sides use the same scheme. Overridable per session.
  const lookupUrl = (session.keepassUrl && session.keepassUrl.trim())
    ? session.keepassUrl.trim()
    : 'ssh://' + session.host;
  const kp = await kpConnect();
  let entries;
  try {
    entries = await kp.getLogins(lookupUrl);
  } finally {
    kp.close();
  }
  if (!entries.length) {
    throw new Error('No KeePassXC entry matched "' + lookupUrl +
      '". Put this exact URL on the entry (URL field or Additional URLs). ' +
      'Tip: use an FQDN (host with a dot); short names rank low under "best match only".');
  }
  // Prefer an entry whose login matches the configured username.
  const entry = entries.find((e) => e.login === session.username) || entries[0];
  const username = session.username || entry.login;

  if (session.auth === 'keepass-key') {
    const privateKey = readStringField(entry, session.keyField || 'privateKey');
    if (!privateKey) {
      throw new Error('No string field "KPH: ' + (session.keyField || 'privateKey') +
        '" on the matched KeePassXC entry.');
    }
    const passphrase = session.passphraseField
      ? readStringField(entry, session.passphraseField) || undefined
      : (entry.password || undefined);
    return { ...base, username, privateKey, passphrase };
  }

  // default: keepass-password
  return { ...base, username, password: entry.password };
}

// --- IPC: sessions ---------------------------------------------------------

ipcMain.handle('sessions:list', () => store.listSessions());
ipcMain.handle('sessions:save', (_e, s) => store.saveSession(s));
ipcMain.handle('sessions:delete', (_e, id) => { store.deleteSession(id); return true; });

// --- IPC: global aliases ---------------------------------------------------

ipcMain.handle('aliases:list', () => store.listAliases());
ipcMain.handle('aliases:save', (_e, aliases) => store.saveAliases(aliases));

// Build the shell command that defines all global aliases. Leading space
// keeps it out of history when the shell uses HISTCONTROL=ignorespace.
function aliasSetup() {
  const aliases = store.listAliases();
  if (!aliases.length) return '';
  const lines = aliases.map((a) => {
    const cmd = a.command.replace(/'/g, "'\\''"); // escape single quotes for shell
    return `alias ${a.name}='${cmd}'`;
  });
  return ' ' + lines.join('; ') + '\n';
}

// --- IPC: macros + settings ------------------------------------------------

ipcMain.handle('macros:list', () => store.listMacros());
ipcMain.handle('macros:save', (_e, macros) => {
  const saved = store.saveMacros(macros);
  buildMenu(); // refresh the Tools → Macros submenu
  return saved;
});

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:save', (_e, s) => {
  const next = store.saveSettings(s);
  buildMenu();
  return next;
});

// Configurable data directory.
ipcMain.handle('config:get', () => ({ dataDir: dataDir(), default: bootstrapDir }));

ipcMain.handle('config:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

const DATA_FILES = ['sessions.json', 'aliases.json', 'macros.json', 'settings.json', 'keepass-association.json'];

ipcMain.handle('config:setDir', async (_e, { dir, move }) => {
  try {
    const target = (dir && dir.trim()) ? path.resolve(dir.trim()) : path.resolve(bootstrapDir);
    const old = path.resolve(dataDir());
    await fsp.mkdir(target, { recursive: true });
    if (move && old !== target) {
      for (const f of DATA_FILES) {
        try { await fsp.copyFile(path.join(old, f), path.join(target, f)); } catch (_) {}
      }
    }
    if (target === path.resolve(bootstrapDir)) {
      try { await fsp.unlink(locationFile()); } catch (_) {}
    } else {
      fs.writeFileSync(locationFile(), JSON.stringify({ dataDir: target }, null, 2), { mode: 0o600 });
    }
    store = makeStore(dataDir()); // swap live; reads are per-call
    buildMenu();
    return { ok: true, dataDir: dataDir() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// --- IPC: KeePass ----------------------------------------------------------

ipcMain.handle('keepass:status', async () => {
  try {
    const kp = await kpConnect({ allowAssociate: false });
    const hash = await kp.getDatabaseHash();
    kp.close();
    return { ok: true, dbHash: hash };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('keepass:associate', async () => {
  try {
    const kp = await kpConnect({ allowAssociate: true });
    kp.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Create/update a KeePassXC entry with a username + password. `url` defaults
// to ssh://<host> so the new entry matches future credential lookups.
ipcMain.handle('keepass:setLogin', async (_e, { url, login, password }) => {
  if (!url || !login) return { ok: false, error: 'URL and username are required.' };
  let kp;
  try {
    kp = await kpConnect();
    await kp.setLogin({ url, login, password: password || '' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (kp) kp.close();
  }
});

// Resolve the jump/gateway host of a session into an ssh2 connect config,
// or null if the session has no jump host. Reuses resolveAuth via a derived
// pseudo-session so the jump host can also pull creds from KeePassXC.
async function resolveJump(session) {
  if (!session.jumpHost || !session.jumpHost.trim()) return null;
  return resolveAuth({
    host: session.jumpHost.trim(),
    port: session.jumpPort,
    username: session.jumpUsername,
    auth: session.jumpAuth || 'agent',
    keepassUrl: session.jumpKeepassUrl,
    keyField: session.jumpKeyField,
    passphraseField: session.jumpPassphraseField,
    agentPath: session.jumpAgentPath,
  });
}

// Start the session's configured port-forwarding tunnels over `conn`.
// Returns a cleanup function that tears everything down.
function startTunnels(conn, session) {
  const tunnels = (session.tunnels || []).filter((t) => t && t.srcPort && t.dstHost && t.dstPort);
  const servers = [];
  const remotes = tunnels.filter((t) => t.type === 'remote');
  const locals = tunnels.filter((t) => t.type !== 'remote');

  for (const t of locals) {
    const srv = net.createServer((sock) => {
      conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0,
        t.dstHost, Number(t.dstPort), (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
        });
    });
    srv.on('error', (e) =>
      win && win.webContents.send('tunnel:error', { sessionId: session.id, error: `local ${t.srcPort}: ${e.message}` }));
    srv.listen(Number(t.srcPort), t.srcHost || '127.0.0.1');
    servers.push(srv);
  }

  let onTcp = null;
  if (remotes.length) {
    for (const t of remotes) {
      conn.forwardIn(t.srcHost || '127.0.0.1', Number(t.srcPort), (err) => {
        if (err) win && win.webContents.send('tunnel:error', { sessionId: session.id, error: `remote ${t.srcPort}: ${err.message}` });
      });
    }
    onTcp = (info, accept, reject) => {
      const t = remotes.find((x) => Number(x.srcPort) === info.destPort);
      if (!t) { reject(); return; }
      const sock = net.connect(Number(t.dstPort), t.dstHost, () => {
        const stream = accept();
        sock.pipe(stream).pipe(sock);
      });
      sock.on('error', () => { try { reject(); } catch (_) {} });
    };
    conn.on('tcp connection', onTcp);
  }

  return () => {
    for (const srv of servers) { try { srv.close(); } catch (_) {} }
    if (onTcp) { try { conn.removeListener('tcp connection', onTcp); } catch (_) {} }
  };
}

// --- IPC: SSH shell --------------------------------------------------------

ipcMain.handle('ssh:connect', async (_e, sessionId) => {
  const session = store.listSessions().find((s) => s.id === sessionId);
  if (!session) return { ok: false, error: 'Unknown session' };
  if (active.has(sessionId)) return { ok: true }; // already connected

  let config, jumpConfig;
  try {
    config = await resolveAuth(session);
    jumpConfig = await resolveJump(session);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const conn = ssh.openShell(config, {
    onReady: (stream) => {
      let stopTunnels = () => {};
      try { stopTunnels = startTunnels(conn, session); }
      catch (e) { win.webContents.send('tunnel:error', { sessionId, error: e.message }); }
      active.set(sessionId, { conn, stream, stopTunnels });
      const setup = aliasSetup();
      if (setup) stream.write(setup);
      win.webContents.send('ssh:status', { sessionId, state: 'ready' });
    },
    onData: (data) => win.webContents.send('ssh:data', { sessionId, data }),
    onClose: () => {
      const s = active.get(sessionId);
      if (s && s.stopTunnels) s.stopTunnels();
      active.delete(sessionId);
      win.webContents.send('ssh:status', { sessionId, state: 'closed' });
    },
    onError: (err) => {
      const s = active.get(sessionId);
      if (s && s.stopTunnels) s.stopTunnels();
      active.delete(sessionId);
      win.webContents.send('ssh:status', { sessionId, state: 'error', error: err.message });
    },
  }, jumpConfig);

  return { ok: true };
});

ipcMain.on('ssh:input', (_e, { sessionId, data }) => {
  const s = active.get(sessionId);
  if (s) s.stream.write(data);
});

ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => {
  const s = active.get(sessionId);
  if (s) s.stream.setWindow(rows, cols, 0, 0);
});

ipcMain.handle('ssh:disconnect', (_e, sessionId) => {
  const s = active.get(sessionId);
  if (s) { try { s.conn.end(); } catch (_) {} active.delete(sessionId); }
  return true;
});

// --- IPC: SFTP -------------------------------------------------------------

ipcMain.handle('sftp:list', async (_e, { sessionId, dir }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  try {
    const target = dir || (await ssh.realpath(s.conn, '.'));
    const items = await ssh.listDir(s.conn, target);
    return { ok: true, dir: target, items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sftp:mkdir', async (_e, { sessionId, remoteDir, name }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  try {
    await ssh.mkdir(s.conn, joinRemote(remoteDir, name));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sftp:rename', async (_e, { sessionId, from, to }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  try {
    await ssh.rename(s.conn, from, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sftp:delete', async (_e, { sessionId, items }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  try {
    for (const it of items) {
      if (it.isDir) await ssh.removeDir(s.conn, it.path);
      else await ssh.removeFile(s.conn, it.path);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Read/write a remote file for the in-app text editor.
ipcMain.handle('sftp:readFile', async (_e, { sessionId, remotePath }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  try {
    return { ok: true, content: await ssh.readFile(s.conn, remotePath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sftp:writeFile', async (_e, { sessionId, remotePath, content }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  try {
    await ssh.writeFile(s.conn, remotePath, content);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// --- IPC: SFTP transfers (with progress) -----------------------------------

let xferSeq = 0;

// Emit a progress event for one transfer to the renderer.
function emitXfer(p) {
  if (win && !win.isDestroyed()) win.webContents.send('sftp:progress', p);
}

function joinRemote(dir, name) {
  return dir.replace(/\/$/, '') + '/' + name;
}

// Expand local paths (files or directories) into an ordered op list:
// directories first (mkdir), then their files (put). Recurses.
async function planUploads(localPaths, remoteDir) {
  const ops = []; // { kind: 'mkdir'|'put', local?, remote, size?, name }
  async function walk(local, remoteParent) {
    const base = path.basename(local);
    const remote = joinRemote(remoteParent, base);
    const st = await fsp.stat(local);
    if (st.isDirectory()) {
      ops.push({ kind: 'mkdir', remote, name: base });
      const entries = await fsp.readdir(local);
      for (const e of entries) await walk(path.join(local, e), remote);
    } else {
      ops.push({ kind: 'put', local, remote, size: st.size, name: base });
    }
  }
  for (const lp of localPaths) await walk(lp, remoteDir);
  return ops;
}

// Run an upload batch, emitting per-file progress. Resolves when all done.
async function runUploads(s, localPaths, remoteDir) {
  let ops;
  try {
    ops = await planUploads(localPaths, remoteDir);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const files = ops.filter((o) => o.kind === 'put');
  for (const op of ops) {
    if (op.kind === 'mkdir') {
      // best-effort: ignore "already exists"
      try { await ssh.mkdir(s.conn, op.remote); } catch (_) {}
      continue;
    }
    const id = ++xferSeq;
    emitXfer({ id, dir: 'up', name: op.name, total: op.size, transferred: 0, state: 'active' });
    try {
      await ssh.upload(s.conn, op.local, op.remote, (t, total) =>
        emitXfer({ id, dir: 'up', name: op.name, total, transferred: t, state: 'active' }));
      emitXfer({ id, dir: 'up', name: op.name, total: op.size, transferred: op.size, state: 'done' });
    } catch (e) {
      emitXfer({ id, dir: 'up', name: op.name, state: 'error', error: e.message });
      return { ok: false, error: e.message, count: files.length };
    }
  }
  return { ok: true, count: files.length };
}

// Drag-and-drop / explicit-path upload (multi-file, recursive folders).
ipcMain.handle('sftp:uploadPaths', async (_e, { sessionId, remoteDir, paths }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  if (!paths || !paths.length) return { ok: false, canceled: true };
  return runUploads(s, paths, remoteDir);
});

// Picker-based upload (multi-select files).
ipcMain.handle('sftp:upload', async (_e, { sessionId, remoteDir }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  return runUploads(s, res.filePaths, remoteDir);
});

// Expand remote items (files or directories) into an ordered op list rooted
// at a local folder: local dirs first (mkdir), then their files (get). Recurses.
async function planDownloads(conn, items, localRoot) {
  const ops = []; // { kind: 'mkdir'|'get', localPath, remotePath?, size?, name }
  async function walk(remotePath, name, isDir, size, localParent) {
    const localPath = path.join(localParent, name);
    if (isDir) {
      ops.push({ kind: 'mkdir', localPath });
      const list = await ssh.listDir(conn, remotePath);
      for (const e of list) {
        await walk(remotePath.replace(/\/$/, '') + '/' + e.name, e.name, e.isDir, e.size, localPath);
      }
    } else {
      ops.push({ kind: 'get', remotePath, localPath, size, name });
    }
  }
  for (const it of items) await walk(it.remotePath, it.name, it.isDir, it.size, localRoot);
  return ops;
}

// Download one or more remote items (files and/or folders, recursive).
// A single plain file → save dialog (lets the user rename). Anything else
// (multiple items, or any folder) → pick a destination folder.
ipcMain.handle('sftp:download', async (_e, { sessionId, items }) => {
  const s = active.get(sessionId);
  if (!s) return { ok: false, error: 'Session not connected' };
  if (!items || !items.length) return { ok: false, canceled: true };

  const onlySingleFile = items.length === 1 && !items[0].isDir;

  let ops;
  if (onlySingleFile) {
    const res = await dialog.showSaveDialog(win, { defaultPath: items[0].name });
    if (res.canceled) return { ok: false, canceled: true };
    ops = [{ kind: 'get', remotePath: items[0].remotePath, localPath: res.filePath, size: items[0].size, name: items[0].name }];
  } else {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try {
      ops = await planDownloads(s.conn, items, res.filePaths[0]);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const files = ops.filter((o) => o.kind === 'get');
  for (const op of ops) {
    if (op.kind === 'mkdir') {
      try { await fsp.mkdir(op.localPath, { recursive: true }); } catch (_) {}
      continue;
    }
    const id = ++xferSeq;
    emitXfer({ id, dir: 'down', name: op.name, total: op.size, transferred: 0, state: 'active' });
    try {
      await ssh.download(s.conn, op.remotePath, op.localPath, (tr, total) =>
        emitXfer({ id, dir: 'down', name: op.name, total, transferred: tr, state: 'active' }));
      emitXfer({ id, dir: 'down', name: op.name, total: op.size, transferred: op.size, state: 'done' });
    } catch (e) {
      emitXfer({ id, dir: 'down', name: op.name, state: 'error', error: e.message });
      return { ok: false, error: e.message, count: files.length };
    }
  }
  return { ok: true, count: files.length };
});

// --- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  bootstrapDir = app.getPath('userData');
  store = makeStore(dataDir());
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const { conn } of active.values()) { try { conn.end(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
