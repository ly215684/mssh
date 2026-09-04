import { ipcMain } from 'electron'
import * as store from '../services/configStore'

export function registerConfigIpc() {
  ipcMain.handle('config:get', () => store.getAll())
  ipcMain.handle('config:saveSettings', (_e, settings) => store.saveSettings(settings))
  ipcMain.handle('conn:save', (_e, conn) => store.saveConnection(conn))
  ipcMain.handle('conn:delete', (_e, id: string) => store.deleteConnection(id))
  ipcMain.handle('group:save', (_e, group) => store.saveGroup(group))
  ipcMain.handle('group:delete', (_e, id: string) => store.deleteGroup(id))
  ipcMain.handle('layout:save', (_e, layout) => store.saveLayout(layout))
}
