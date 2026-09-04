import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { RendererApi } from './shared/api'

/** 需要透传的事件订阅（返回卸载函数所需 listener） */
function listener<A extends unknown[]>(cb: (...args: A) => void) {
  return (_e: IpcRendererEvent, ...args: A) => cb(...args)
}

const api: RendererApi = {
  platform: process.platform,

  win: {
    minimize: () => ipcRenderer.invoke('win:min'),
    maximize: () => ipcRenderer.invoke('win:max'),
    close: () => ipcRenderer.invoke('win:close'),
  },

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveSettings: settings => ipcRenderer.invoke('config:saveSettings', settings),
  saveConnection: conn => ipcRenderer.invoke('conn:save', conn),
  deleteConnection: id => ipcRenderer.invoke('conn:delete', id),
  saveGroup: group => ipcRenderer.invoke('group:save', group),
  deleteGroup: id => ipcRenderer.invoke('group:delete', id),
  saveLayout: layout => ipcRenderer.invoke('layout:save', layout),
  openPath: p => ipcRenderer.invoke('app:openPath', p),
  pickPrivateKey: () => ipcRenderer.invoke('app:pickPrivateKey'),
  pathForFile: file => webUtils.getPathForFile(file),

  sshConnect: (conn, sshSettings) => ipcRenderer.invoke('ssh:connect', conn, sshSettings),
  sshWrite: (sessionId, data) => ipcRenderer.invoke('ssh:write', sessionId, data),
  sshResize: (sessionId, cols, rows) => ipcRenderer.invoke('ssh:resize', sessionId, cols, rows),
  sshDisconnect: sessionId => ipcRenderer.invoke('ssh:disconnect', sessionId),
  onSshData: (sessionId, cb) => {
    const l = listener<[string, string]>((id, data) => {
      if (id === sessionId) cb(data)
    })
    ipcRenderer.on('ssh:data', l)
    return () => ipcRenderer.off('ssh:data', l)
  },
  onSshExit: (sessionId, cb) => {
    const l = listener<[string]>(id => {
      if (id === sessionId) cb()
    })
    ipcRenderer.on('ssh:exit', l)
    return () => ipcRenderer.off('ssh:exit', l)
  },

  sftpList: (sessionId, dir) => ipcRenderer.invoke('sftp:list', sessionId, dir),
  sftpMkdir: (sessionId, dir) => ipcRenderer.invoke('sftp:mkdir', sessionId, dir),
  sftpRm: (sessionId, target) => ipcRenderer.invoke('sftp:rm', sessionId, target),
  sftpRename: (sessionId, from, to) => ipcRenderer.invoke('sftp:rename', sessionId, from, to),
  sftpRealpath: (sessionId, p) => ipcRenderer.invoke('sftp:realpath', sessionId, p),
  sftpHome: sessionId => ipcRenderer.invoke('sftp:home', sessionId),
  sftpUpload: (sessionId, localPaths, remoteDir) =>
    ipcRenderer.invoke('sftp:upload', sessionId, localPaths, remoteDir),
  sftpDownload: (sessionId, remotePaths, localDir) =>
    ipcRenderer.invoke('sftp:download', sessionId, remotePaths, localDir),
  onTransfer: cb => {
    const listener = (_e: IpcRendererEvent, item: Parameters<typeof cb>[0]) => cb(item)
    ipcRenderer.on('transfer:progress', listener)
    return () => ipcRenderer.off('transfer:progress', listener)
  },

  localList: dir => ipcRenderer.invoke('local:list', dir),
  localHome: () => ipcRenderer.invoke('local:home'),
  localDesktop: () => ipcRenderer.invoke('local:desktop'),
  localDrives: () => ipcRenderer.invoke('local:drives'),
  localMkdir: dir => ipcRenderer.invoke('local:mkdir', dir),
  localRm: target => ipcRenderer.invoke('local:rm', target),
  localRename: (from, to) => ipcRenderer.invoke('local:rename', from, to),
}

contextBridge.exposeInMainWorld('api', api)
