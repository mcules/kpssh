'use strict';

// Thin wrapper around ssh2: interactive shell + SFTP file operations.
const { Client } = require('ssh2');

// Open a connection and an interactive shell.
// `config` is a standard ssh2 connect config (host, port, username, and one
// of: password / privateKey+passphrase / agent).
// `handlers`: { onReady(stream, conn), onData(str), onClose(), onError(err) }
// `jumpConfig` (optional): connect config for a jump/gateway host. When given,
// we connect to the jump host first, open a forwarded channel to the target,
// and run the real connection over it (ProxyJump / -J equivalent).
function openShell(config, handlers, jumpConfig) {
  const conn = new Client();
  let jump = null;

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) { handlers.onError(err); return; }
      handlers.onReady(stream, conn);
      stream.on('data', (d) => handlers.onData(d.toString('utf8')));
      stream.stderr.on('data', (d) => handlers.onData(d.toString('utf8')));
      stream.on('close', () => { try { conn.end(); } catch (_) {} });
    });
  });
  conn.on('error', (e) => handlers.onError(e));
  conn.on('close', () => { if (jump) { try { jump.end(); } catch (_) {} } handlers.onClose(); });

  if (jumpConfig) {
    jump = new Client();
    jump.on('ready', () => {
      jump.forwardOut('127.0.0.1', 0, config.host, config.port || 22, (err, sock) => {
        if (err) { handlers.onError(new Error('Jump host: ' + err.message)); try { jump.end(); } catch (_) {} return; }
        conn.connect({ ...config, sock });
      });
    });
    jump.on('error', (e) => handlers.onError(new Error('Jump host: ' + e.message)));
    jump.connect(jumpConfig);
  } else {
    conn.connect(config);
  }
  return conn;
}

// One SFTP channel per connection, reused across calls. Opening a fresh
// channel for every list/transfer exhausts the server's MaxSessions limit
// and yields "Channel open failure: open failed" after a handful of clicks.
const sftpCache = new WeakMap(); // conn -> Promise<sftp>

function getSftp(conn) {
  const cached = sftpCache.get(conn);
  if (cached) return cached;
  const p = new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { sftpCache.delete(conn); return reject(err); }
      // Evict on teardown so the next call re-opens a healthy channel.
      const evict = () => { if (sftpCache.get(conn) === p) sftpCache.delete(conn); };
      sftp.on('close', evict);
      sftp.on('end', evict);
      sftp.on('error', evict);
      resolve(sftp);
    });
  });
  sftpCache.set(conn, p);
  return p;
}

async function listDir(conn, dir) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return reject(err);
      const items = list.map((e) => ({
        name: e.filename,
        size: e.attrs.size,
        isDir: e.attrs.isDirectory(),
        mtime: e.attrs.mtime,
      }));
      items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      resolve(items);
    });
  });
}

async function realpath(conn, p) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
  });
}

// `onStep(transferred, total)` is called periodically during the transfer.
async function download(conn, remotePath, localPath, onStep) {
  const sftp = await getSftp(conn);
  const opts = onStep ? { step: (t, _c, total) => onStep(t, total) } : {};
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, opts, (err) => (err ? reject(err) : resolve(localPath)));
  });
}

async function upload(conn, localPath, remotePath, onStep) {
  const sftp = await getSftp(conn);
  const opts = onStep ? { step: (t, _c, total) => onStep(t, total) } : {};
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, opts, (err) => (err ? reject(err) : resolve(remotePath)));
  });
}

async function mkdir(conn, remotePath) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve(remotePath)));
  });
}

async function rename(conn, from, to) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve(to)));
  });
}

// Remove a single file.
async function removeFile(conn, remotePath) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve(remotePath)));
  });
}

// Recursively remove a directory and its contents.
async function removeDir(conn, remotePath) {
  const sftp = await getSftp(conn);
  const readdir = (dir) => new Promise((res, rej) =>
    sftp.readdir(dir, (e, l) => (e ? rej(e) : res(l))));
  const unlink = (p) => new Promise((res, rej) =>
    sftp.unlink(p, (e) => (e ? rej(e) : res())));
  const rmdir = (p) => new Promise((res, rej) =>
    sftp.rmdir(p, (e) => (e ? rej(e) : res())));

  async function walk(dir) {
    const list = await readdir(dir);
    for (const e of list) {
      const child = dir.replace(/\/$/, '') + '/' + e.filename;
      if (e.attrs.isDirectory()) await walk(child);
      else await unlink(child);
    }
    await rmdir(dir);
  }
  await walk(remotePath);
  return remotePath;
}

// Read a whole remote file into a utf8 string (for the in-app editor).
async function readFile(conn, remotePath) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (err, buf) => (err ? reject(err) : resolve(buf.toString('utf8'))));
  });
}

// Overwrite a remote file with the given utf8 content.
async function writeFile(conn, remotePath, content) {
  const sftp = await getSftp(conn);
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), (err) => (err ? reject(err) : resolve(remotePath)));
  });
}

module.exports = {
  openShell, listDir, realpath, download, upload,
  mkdir, rename, removeFile, removeDir, readFile, writeFile,
};
