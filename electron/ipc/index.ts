import { registerAppIpc } from './appIpc'
import { registerConfigIpc } from './configIpc'
import { registerSshIpc } from './sshIpc'
import { registerSftpIpc } from './sftpIpc'
import { registerLocalFsIpc } from './localFsIpc'

/** 在 app.whenReady 前统一注册所有 IPC handler */
export function registerAllIpc() {
  registerAppIpc()
  registerConfigIpc()
  registerSshIpc()
  registerSftpIpc()
  registerLocalFsIpc()
}
