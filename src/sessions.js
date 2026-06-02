'use strict';

// Simple JSON persistence for sessions and the KeePassXC association,
// stored in Electron's per-user userData directory.
const fs = require('fs');
const path = require('path');

function makeStore(userDataDir) {
  const sessionsFile = path.join(userDataDir, 'sessions.json');
  const assocFile = path.join(userDataDir, 'keepass-association.json');
  const aliasFile = path.join(userDataDir, 'aliases.json');
  const macroFile = path.join(userDataDir, 'macros.json');
  const settingsFile = path.join(userDataDir, 'settings.json');

  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return fallback; }
  };
  const writeJson = (file, data) =>
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });

  return {
    listSessions: () => readJson(sessionsFile, []),
    saveSession(session) {
      const sessions = readJson(sessionsFile, []);
      if (!session.id) session.id = 's_' + Date.now().toString(36);
      const i = sessions.findIndex((s) => s.id === session.id);
      if (i >= 0) sessions[i] = session; else sessions.push(session);
      writeJson(sessionsFile, sessions);
      return session;
    },
    deleteSession(id) {
      writeJson(sessionsFile, readJson(sessionsFile, []).filter((s) => s.id !== id));
    },
    getAssociation: () => readJson(assocFile, null),
    saveAssociation: (assoc) => writeJson(assocFile, assoc),

    // Global aliases applied to every SSH shell on connect.
    listAliases: () => readJson(aliasFile, []),
    saveAliases(aliases) {
      const clean = (aliases || [])
        .map((a) => ({ name: String(a.name || '').trim(), command: String(a.command || '').trim() }))
        .filter((a) => a.name && a.command);
      writeJson(aliasFile, clean);
      return clean;
    },

    // Named command snippets (macros) runnable against any session.
    listMacros: () => readJson(macroFile, []),
    saveMacros(macros) {
      const clean = (macros || [])
        .map((m) => ({
          id: m.id || 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: String(m.name || '').trim(),
          script: String(m.script || ''),
        }))
        .filter((m) => m.name && m.script.trim());
      writeJson(macroFile, clean);
      return clean;
    },

    // App settings (e.g. global syntax highlighting). Defaults merged in.
    getSettings: () => ({ syntaxHighlight: true, fontSize: 13, ...readJson(settingsFile, {}) }),
    saveSettings(s) {
      const cur = readJson(settingsFile, {});
      const next = { ...cur, ...(s || {}) };
      writeJson(settingsFile, next);
      return next;
    },
  };
}

module.exports = { makeStore };
