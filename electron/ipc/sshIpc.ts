import { ipcMain } from 'electron'
import * as ssh from '../services/sshService'

export function registerSshIpc() {
  ipcMain.handle('ssh:connect', (_e, cfg, sshSettings) => ssh.connect(cfg, sshSettings))
  ipcMain.handle('ssh:write', (_e, sessionId: string, data: string) => ssh.write(sessionId, data))
  ipcMain.handle('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    ssh.resize(sessionId, cols, rows),
  )
  ipcMain.handle('ssh:disconnect', (_e, sessionId: string) => ssh.disconnect(sessionId))
}
