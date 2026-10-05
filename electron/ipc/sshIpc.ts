import { ipcMain } from 'electron'
import * as ssh from '../services/sshService'
import * as telnet from '../services/telnetService'

export function registerSshIpc() {
  // 按连接协议分发（Connection.protocol 缺省为 ssh）
  ipcMain.handle('ssh:connect', (_e, cfg, sshSettings) =>
    cfg.protocol === 'telnet' ? telnet.connect(cfg, sshSettings) : ssh.connect(cfg, sshSettings),
  )
  // 会话级操作按 sessionId 归属路由（telnet 与 ssh 会话共用 ssh:data / ssh:exit 事件通道）
  ipcMain.handle('ssh:write', (_e, sessionId: string, data: string) =>
    telnet.has(sessionId) ? telnet.write(sessionId, data) : ssh.write(sessionId, data),
  )
  ipcMain.handle('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    telnet.has(sessionId) ? telnet.resize(sessionId, cols, rows) : ssh.resize(sessionId, cols, rows),
  )
  ipcMain.handle('ssh:disconnect', (_e, sessionId: string) =>
    telnet.has(sessionId) ? telnet.disconnect(sessionId) : ssh.disconnect(sessionId),
  )
  ipcMain.handle('ssh:stats', (_e, sessionId: string) => ssh.getSysStats(sessionId))
  ipcMain.handle('ssh:exec', (_e, sessionId: string, command: string) =>
    ssh.execCommand(sessionId, command),
  )
  ipcMain.handle('ssh:execStream', (_e, sessionId: string, command: string) =>
    ssh.execStream(sessionId, command),
  )
  ipcMain.handle('ssh:streamKill', (_e, streamId: string) => ssh.killStream(streamId))
}
