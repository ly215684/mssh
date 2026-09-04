import { ipcMain } from 'electron'
import { checkForUpdates, downloadUpdate, installUpdate, updaterActive } from '../services/autoUpdateService'

export function registerUpdateIpc() {
  ipcMain.handle('update:active', () => updaterActive())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())
}
