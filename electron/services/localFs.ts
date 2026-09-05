import { app } from 'electron'
import { exec } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FileInfo } from '../shared/types'

const execAsync = promisify(exec)

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

/** 创建空文件 */
export async function touchFile(p: string): Promise<void> {
  await fsp.writeFile(p, '')
}

/**
 * 本地解压：根据扩展名调用系统命令。
 * - .tar* / .zip：Windows 10+ 自带 tar（bsdtar 支持 zip）
 * - .7z：调用 7z（需安装，PATH 中）
 * - .gz/.bz2/.xz：需要对应工具（Windows 需安装）
 */
export async function extract(filePath: string): Promise<void> {
  const lower = filePath.toLowerCase()
  const dir = path.dirname(filePath)
  const isWin = process.platform === 'win32'
  let cmd: string | null = null

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    cmd = `tar -xzf "${filePath}" -C "${dir}"`
  } else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    cmd = `tar -xjf "${filePath}" -C "${dir}"`
  } else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    cmd = `tar -xJf "${filePath}" -C "${dir}"`
  } else if (lower.endsWith('.tar')) {
    cmd = `tar -xf "${filePath}" -C "${dir}"`
  } else if (lower.endsWith('.zip')) {
    // Windows 优先用 PowerShell Expand-Archive，失败回退 tar
    if (isWin) {
      cmd = `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${filePath}' -DestinationPath '${dir}' -Force"`
    } else {
      cmd = `unzip -o "${filePath}" -d "${dir}"`
    }
  } else if (lower.endsWith('.7z')) {
    cmd = `7z x "${filePath}" -o"${dir}" -y`
  } else if (lower.endsWith('.gz')) {
    cmd = isWin
      ? `powershell -NoProfile -Command "$s=[IO.File]::OpenRead('${filePath}'); $g=New-Object IO.Compression.GzipStream($s,[IO.Compression.CompressionMode]::Decompress); $fs=[IO.File]::Create('${filePath.slice(0,-3)}'); $g.CopyTo($fs); $fs.Close(); $g.Close()"`
      : `gunzip -k -f "${filePath}"`
  } else {
    throw new Error(`不支持的压缩格式：${filePath}`)
  }

  try {
    await execAsync(cmd)
  } catch (e: any) {
    throw new Error(e.stderr?.trim() || e.message || '解压失败')
  }
}
