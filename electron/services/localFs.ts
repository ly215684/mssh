import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FileInfo } from '../shared/types'

/** 列出本地目录 */
export async function listDir(dir: string): Promise<FileInfo[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const infos = await Promise.all(
    entries.map(async e => {
      const full = path.join(dir, e.name)
      try {
        const st = await fsp.stat(full)
        return {
          name: e.name,
          path: full,
          isDir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
          symlink: e.isSymbolicLink(),
        }
      } catch {
        return { name: e.name, path: full, isDir: e.isDirectory(), size: 0, mtime: 0 }
      }
    }),
  )
  return sortEntries(infos)
}

/** 目录优先、名称次序（不区分大小写） */
export function sortEntries(infos: FileInfo[]): FileInfo[] {
  return [...infos].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}

export async function homeDir(): Promise<string> {
  return app.getPath('home')
}

/** 桌面目录（自动处理 OneDrive 重定向） */
export async function desktopDir(): Promise<string> {
  return app.getPath('desktop')
}

/** Windows 盘符列表（其他平台返回根目录） */
export async function drives(): Promise<string[]> {
  if (process.platform === 'win32') {
    const out: string[] = []
    for (let i = 65; i <= 90; i++) {
      const drive = `${String.fromCharCode(i)}:\\`
      try {
        await fsp.access(drive)
        out.push(drive)
      } catch {
        // 盘符不存在
      }
    }
    return out
  }
  return ['/']
}

export async function mkdir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

export async function rm(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true })
}

export async function rename(from: string, to: string): Promise<void> {
  await fsp.rename(from, to)
}
