import { BrowserWindow, ipcMain } from 'electron'
import type { SyncScope, WebDavSettings } from '../shared/types'
import {
  downloadWebDav,
  exportToFile,
  importFromFile,
  testWebDav,
  uploadWebDav,
} from '../services/syncService'

export function registerSyncIpc() {
  ipcMain.handle('sync:exportFile', (e, password: string, scope: SyncScope) =>
    exportToFile(password, scope, BrowserWindow.fromWebContents(e.sender)),
  )
  ipcMain.handle('sync:importFile', (e, password: string) =>
    importFromFile(password, BrowserWindow.fromWebContents(e.sender)),
  )
  ipcMain.handle('sync:testWebdav', (_e, webdav: WebDavSettings) => testWebDav(webdav))
  ipcMain.handle(
    'sync:uploadWebdav',
    (_e, password: string, webdav: WebDavSettings, scope: SyncScope) =>
      uploadWebDav(password, webdav, scope),
  )
  ipcMain.handle(
    'sync:downloadWebdav',
    (_e, password: string, webdav: WebDavSettings, scope: SyncScope) =>
      downloadWebDav(password, webdav, scope),
  )
}
