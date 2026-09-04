import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'

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
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // 剪贴板（渲染进程直接调 navigator.clipboard 可能被权限限制，走主进程更可靠）
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:writeText', (_e, text: string) => clipboard.writeText(text))
}
