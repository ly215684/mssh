import { ipcMain } from 'electron'
import * as sftp from '../services/sftpService'

export function registerSftpIpc() {
  ipcMain.handle('sftp:list', (_e, sessionId: string, dir: string) => sftp.list(sessionId, dir))
  ipcMain.handle('sftp:mkdir', (_e, sessionId: string, dir: string) => sftp.mkdir(sessionId, dir))
  ipcMain.handle('sftp:rm', (_e, sessionId: string, target: string) => sftp.rm(sessionId, target))
  ipcMain.handle('sftp:rename', (_e, sessionId: string, from: string, to: string) =>
    sftp.rename(sessionId, from, to),
  )
  ipcMain.handle('sftp:realpath', (_e, sessionId: string, p: string) => sftp.realpath(sessionId, p))
  ipcMain.handle('sftp:home', (_e, sessionId: string) => sftp.home(sessionId))
  ipcMain.handle('sftp:upload', (_e, sessionId: string, localPaths: string[], remoteDir: string) =>
    sftp.upload(sessionId, localPaths, remoteDir),
  )
  ipcMain.handle(
    'sftp:download',
    (_e, sessionId: string, remotePaths: string[], localDir: string) =>
      sftp.download(sessionId, remotePaths, localDir),
  )
}
