'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // sessions
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),

  // global aliases
  listAliases: () => ipcRenderer.invoke('aliases:list'),
  saveAliases: (aliases) => ipcRenderer.invoke('aliases:save', aliases),

  // macros + settings
  listMacros: () => ipcRenderer.invoke('macros:list'),
  saveMacros: (macros) => ipcRenderer.invoke('macros:save', macros),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  configGet: () => ipcRenderer.invoke('config:get'),
  configPickDir: () => ipcRenderer.invoke('config:pickDir'),
  configSetDir: (dir, move) => ipcRenderer.invoke('config:setDir', { dir, move }),

  // application menu → renderer actions
  onMenuAliases: (cb) => ipcRenderer.on('menu:aliases', () => cb()),
  onMenuPair: (cb) => ipcRenderer.on('menu:pair', () => cb()),
  onMenuMacros: (cb) => ipcRenderer.on('menu:macros', () => cb()),
  onMenuRunMacro: (cb) => ipcRenderer.on('menu:runMacro', (_e, id) => cb(id)),
  onMenuMultiexec: (cb) => ipcRenderer.on('menu:multiexec', () => cb()),
  onMenuSettings: (cb) => ipcRenderer.on('menu:settings', () => cb()),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onTunnelError: (cb) => ipcRenderer.on('tunnel:error', (_e, p) => cb(p)),

  // keepass
  keepassStatus: () => ipcRenderer.invoke('keepass:status'),
  keepassAssociate: () => ipcRenderer.invoke('keepass:associate'),
  keepassSetLogin: (url, login, password) =>
    ipcRenderer.invoke('keepass:setLogin', { url, login, password }),

  // ssh shell
  sshConnect: (sessionId) => ipcRenderer.invoke('ssh:connect', sessionId),
  sshDisconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
  sshInput: (sessionId, data) => ipcRenderer.send('ssh:input', { sessionId, data }),
  sshResize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),
  onSshData: (cb) => ipcRenderer.on('ssh:data', (_e, p) => cb(p)),
  onSshStatus: (cb) => ipcRenderer.on('ssh:status', (_e, p) => cb(p)),

  // sftp
  sftpList: (sessionId, dir) => ipcRenderer.invoke('sftp:list', { sessionId, dir }),
  sftpDownload: (sessionId, items) => ipcRenderer.invoke('sftp:download', { sessionId, items }),
  sftpUpload: (sessionId, remoteDir) => ipcRenderer.invoke('sftp:upload', { sessionId, remoteDir }),
  sftpUploadPaths: (sessionId, remoteDir, paths) =>
    ipcRenderer.invoke('sftp:uploadPaths', { sessionId, remoteDir, paths }),
  sftpMkdir: (sessionId, remoteDir, name) =>
    ipcRenderer.invoke('sftp:mkdir', { sessionId, remoteDir, name }),
  sftpRename: (sessionId, from, to) => ipcRenderer.invoke('sftp:rename', { sessionId, from, to }),
  sftpDelete: (sessionId, items) => ipcRenderer.invoke('sftp:delete', { sessionId, items }),
  sftpReadFile: (sessionId, remotePath) => ipcRenderer.invoke('sftp:readFile', { sessionId, remotePath }),
  sftpWriteFile: (sessionId, remotePath, content) =>
    ipcRenderer.invoke('sftp:writeFile', { sessionId, remotePath, content }),
  onSftpProgress: (cb) => ipcRenderer.on('sftp:progress', (_e, p) => cb(p)),

  // resolve the absolute path of a dropped File (Electron 30+ API)
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
