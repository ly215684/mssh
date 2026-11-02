import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 私钥文件大小上限（防止误选大文件占用内存） */
const MAX_PRIVATE_KEY_SIZE = 2 * 1024 * 1024

/** 读取私钥文件内容（渲染进程按内容加密保存，不再依赖本机路径） */
async function readPrivateKeyFile(p: string): Promise<string> {
  const stat = await fsp.stat(p)
  if (!stat.isFile()) throw new Error('所选路径不是文件')
  if (stat.size > MAX_PRIVATE_KEY_SIZE) throw new Error('私钥文件过大（超过 2 MB）')
  return fsp.readFile(p, 'utf8')
}

export function registerAppIpc() {
  ipcMain.handle('win:min', e => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })

  ipcMain.handle('win:max', e => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle('win:close', e => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  ipcMain.handle('app:openPath', (_e, p: string) => shell.openPath(p))

  ipcMain.handle('app:pickPrivateKey', async e => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, {
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const p = r.filePaths[0]
    return { path: p, name: path.basename(p), content: await readPrivateKeyFile(p) }
  })

  ipcMain.handle('app:readPrivateKeyFile', (_e, p: string) => readPrivateKeyFile(p))

  // 剪贴板（渲染进程直接调 navigator.clipboard 可能被权限限制，走主进程更可靠）
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:writeText', (_e, text: string) => clipboard.writeText(text))
}
