'use strict';

// KeePassXC Browser Integration protocol client ("Option A").
// Connects to a RUNNING, UNLOCKED KeePassXC instance over its local
// socket / named pipe and retrieves credentials without ever seeing the
// master password. Communication is end-to-end encrypted with NaCl boxes.
//
// Protocol reference:
// https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md
//
// IMPORTANT: this protocol exposes username, password, TOTP and custom
// string fields (the "KPH: <name>" fields). It does NOT expose file
// attachments, so SSH keys stored as KeeAgent attachments are not reachable
// this way. To pull a key via this protocol, store it in a custom string
// field (see README). For attachment-based keys, use the SSH agent instead.

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const nacl = require('tweetnacl');

const SERVER_NAME = 'org.keepassxc.KeePassXC.BrowserServer';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// Resolve candidate socket / named-pipe paths. The Windows named-pipe name
// has differed across KeePassXC versions, so we try the known variants in
// order. Returns an array; connect() probes each until one accepts.
function socketCandidates() {
  if (process.platform === 'win32') {
    const user = os.userInfo().username;
    return [
      '\\\\.\\pipe\\' + SERVER_NAME + '_' + user,                 // current
      '\\\\.\\pipe\\' + SERVER_NAME,                              // no-user variant
      '\\\\.\\pipe\\keepassxc\\' + user + '\\' + SERVER_NAME,     // proxy-rust variant
    ];
  }
  if (process.platform === 'darwin' && process.env.TMPDIR) {
    return [path.join(process.env.TMPDIR, SERVER_NAME)];
  }
  if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
    const dir = process.env.XDG_RUNTIME_DIR;
    return [
      path.join(dir, 'app/org.keepassxc.KeePassXC', SERVER_NAME), // sandboxed
      path.join(dir, SERVER_NAME),                                // legacy
    ];
  }
  return [path.join('/tmp', SERVER_NAME)];
}

// 24-byte big-endian nonce increment, matching the reference clients.
function incrementNonce(nonce) {
  const n = Uint8Array.from(nonce);
  for (let i = n.length - 1; i >= 0; i--) {
    if (n[i] === 255) { n[i] = 0; } else { n[i] += 1; break; }
  }
  return n;
}

class KeePassConnection {
  constructor() {
    const kp = nacl.box.keyPair();
    this.secretKey = kp.secretKey;
    this.publicKey = kp.publicKey;
    this.clientId = b64(nacl.randomBytes(24));
    this.nonce = nacl.randomBytes(24);
    this.serverPublicKey = null;
    this.associateId = null;   // association name assigned by KeePassXC
    this.idPublicKey = null;   // association public key identifying this app
    this.socket = null;
  }

  // Try each candidate path until one accepts the connection.
  _openSocket() {
    const candidates = socketCandidates();
    return new Promise((resolve, reject) => {
      let i = 0;
      const tryNext = () => {
        if (i >= candidates.length) {
          return reject(new Error(
            'Cannot reach KeePassXC. Tried: ' + candidates.join(' | ') +
            '. Is KeePassXC running with browser integration enabled and the database unlocked?'));
        }
        const p = candidates[i++];
        const s = net.connect(p);
        const onErr = () => { clearTimeout(timer); try { s.destroy(); } catch (_) {} tryNext(); };
        const timer = setTimeout(onErr, 1500); // pipe exists but never accepts -> move on
        s.once('error', onErr);
        s.once('connect', () => {
          clearTimeout(timer);
          s.removeListener('error', onErr);
          resolve(s);
        });
      };
      tryNext();
    });
  }

  async connect() {
    this.socket = await this._openSocket();
    // Step 1: exchange public keys (this message is NOT encrypted).
    const resp = await this._sendRaw({
      action: 'change-public-keys',
      publicKey: b64(this.publicKey),
      nonce: b64(this.nonce),
      clientID: this.clientId,
    });
    if (!resp.success || !resp.publicKey) throw new Error('Key exchange failed');
    this.serverPublicKey = fromB64(resp.publicKey);
    this.nonce = incrementNonce(this.nonce);
  }

  // Read exactly one JSON message from the socket.
  _readOnce() {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for KeePassXC response'));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeListener('data', onData);
        this.socket.removeListener('error', onErr);
      };
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        try {
          const json = JSON.parse(buf);
          cleanup();
          resolve(json);
        } catch (_) { /* partial frame, wait for more */ }
      };
      const onErr = (e) => { cleanup(); reject(e); };
      this.socket.on('data', onData);
      this.socket.once('error', onErr);
    });
  }

  _sendRaw(obj) {
    const p = this._readOnce();
    this.socket.write(JSON.stringify(obj));
    return p;
  }

  _encryptedRequest(msg, extra = {}) {
    const plaintext = Buffer.from(JSON.stringify(msg), 'utf8');
    const cipher = nacl.box(plaintext, this.nonce, this.serverPublicKey, this.secretKey);
    const wrapper = {
      action: msg.action,
      message: b64(cipher),
      nonce: b64(this.nonce),
      clientID: this.clientId,
      ...extra,
    };
    const p = this._readOnce();
    this.socket.write(JSON.stringify(wrapper));
    this.nonce = incrementNonce(this.nonce);
    return p.then((raw) => this._decrypt(raw));
  }

  _decrypt(raw) {
    if (raw.error) {
      throw new Error('KeePassXC: ' + raw.error + ' (code ' + raw.errorCode + ')');
    }
    const opened = nacl.box.open(
      fromB64(raw.message), fromB64(raw.nonce), this.serverPublicKey, this.secretKey);
    if (!opened) throw new Error('Failed to decrypt KeePassXC response');
    const resp = JSON.parse(Buffer.from(opened).toString('utf8'));
    if (resp.success !== true && resp.success !== 'true') {
      throw new Error('KeePassXC request was not successful');
    }
    return resp;
  }

  async getDatabaseHash() {
    const resp = await this._encryptedRequest({ action: 'get-databasehash' });
    return resp.hash;
  }

  // Pairs this app with the database. Pops a dialog in KeePassXC where the
  // user names the connection. Returns the association to persist.
  async associate() {
    const idKeys = nacl.box.keyPair();
    this.idPublicKey = idKeys.publicKey; // only the public part is needed later
    const resp = await this._encryptedRequest({
      action: 'associate',
      key: b64(this.publicKey),
      idKey: b64(this.idPublicKey),
    });
    this.associateId = resp.id;
    return { id: this.associateId, idPublicKey: b64(this.idPublicKey) };
  }

  // Restore a previously stored association so no new dialog is needed.
  loadAssociation(id, idPublicKeyB64) {
    this.associateId = id;
    this.idPublicKey = fromB64(idPublicKeyB64);
  }

  async testAssociate(triggerUnlock = false) {
    try {
      await this._encryptedRequest(
        { action: 'test-associate', id: this.associateId, key: b64(this.idPublicKey) },
        triggerUnlock ? { triggerUnlock: 'true' } : {});
      return true;
    } catch (_) {
      return false;
    }
  }

  // Look up credentials for a URL. KeePassXC matches against entry URLs and
  // requires an http(s) scheme, so store SSH entries with a URL like
  // "https://my-server" (see README).
  // Returns: [{ login, name, password, stringFields: [{ "KPH: x": "..." }] }]
  async getLogins(url) {
    const resp = await this._encryptedRequest({
      action: 'get-logins',
      url,
      keys: [{ id: this.associateId, key: b64(this.idPublicKey) }],
    });
    return resp.entries || [];
  }

  // Create or update an entry in KeePassXC. Without `uuid` a new entry is
  // created; KeePassXC may show a confirmation dialog depending on its
  // settings. The entry's URL is set to `url` so later get-logins(url) matches.
  async setLogin({ url, login, password, group, groupUuid, uuid }) {
    const msg = {
      action: 'set-login',
      url,
      submitUrl: url,
      id: this.associateId,
      login,
      password,
    };
    if (uuid) msg.uuid = uuid;
    if (group) msg.group = group;
    if (groupUuid) msg.groupUuid = groupUuid;
    return this._encryptedRequest(msg);
  }

  close() {
    if (this.socket) { try { this.socket.end(); } catch (_) {} this.socket = null; }
  }
}

// Pull a single custom string field value ("KPH: <name>") from an entry.
function readStringField(entry, fieldName) {
  if (!entry || !Array.isArray(entry.stringFields)) return null;
  const key = 'KPH: ' + fieldName;
  for (const f of entry.stringFields) {
    if (Object.prototype.hasOwnProperty.call(f, key)) return f[key];
  }
  return null;
}

module.exports = { KeePassConnection, socketCandidates, readStringField };
