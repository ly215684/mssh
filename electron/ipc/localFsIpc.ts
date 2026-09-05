import { ipcMain } from 'electron'
import * as localFs from '../services/localFs'

export function registerLocalFsIpc() {
  ipcMain.handle('local:list', (_e, dir: string) => localFs.listDir(dir))
  ipcMain.handle('local:home', () => localFs.homeDir())
  ipcMain.handle('local:desktop', () => localFs.desktopDir())
  ipcMain.handle('local:drives', () => localFs.drives())
  ipcMain.handle('local:mkdir', (_e, dir: string) => localFs.mkdir(dir))
  ipcMain.handle('local:rm', (_e, target: string) => localFs.rm(target))
  ipcMain.handle('local:rename', (_e, from: string, to: string) => localFs.rename(from, to))
  ipcMain.handle('local:touch', (_e, p: string) => localFs.touchFile(p))
  ipcMain.handle('local:extract', (_e, p: string) => localFs.extract(p))
}
