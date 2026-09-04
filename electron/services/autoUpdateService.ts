/**
 * 自动更新服务（基于 electron-updater + GitHub Releases）
 *
 * - 仅在打包后的环境中启用（dev 跳过）
 * - 手动确认后才下载（autoDownload = false）
 * - 事件统一以 'update:event' 转发给渲染进程
 */
import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

type UpdateEventType =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'progress'
  | 'downloaded'
  | 'error'

function sendEvent(type: UpdateEventType, payload?: unknown) {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('update:event', { type, payload }))
}

/** 是否允许检查更新（dev / 非 AppImage 的 linux 等场景返回 false） */
export function updaterActive(): boolean {
  if (!app.isPackaged) return false
  return autoUpdater.isUpdaterActive()
}

export function initAutoUpdater() {
  if (!updaterActive()) return

  autoUpdater.autoDownload = false
  // 下载完成后即使用户不点安装，退出时也会自动安装
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => sendEvent('checking'))
  autoUpdater.on('update-available', info => sendEvent('available', { version: info.version }))
  autoUpdater.on('update-not-available', () => sendEvent('not-available'))
  autoUpdater.on('download-progress', p =>
    sendEvent('progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    }),
  )
  autoUpdater.on('update-downloaded', info => sendEvent('downloaded', { version: info.version }))
  autoUpdater.on('error', e => sendEvent('error', { message: e?.message ?? String(e) }))
}

/** 手动/自动检查更新，返回最新版本号（仅用于日志与提示） */
export function checkForUpdates(): Promise<string | null> {
  if (!updaterActive()) return Promise.resolve(null)
  return autoUpdater
    .checkForUpdates()
    .then(r => r?.updateInfo.version ?? null)
    .catch(e => {
      // checkForUpdates 的 reject 也会触发 error 事件，这里仅兜底返回
      sendEvent('error', { message: e?.message ?? String(e) })
      return null
    })
}

export function downloadUpdate() {
  if (!updaterActive()) return
  autoUpdater.downloadUpdate().catch(() => {/* error 事件已转发 */})
}

export function installUpdate() {
  if (!updaterActive()) return
  autoUpdater.quitAndInstall()
}
