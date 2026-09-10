import { app } from 'electron'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FileInfo } from '../shared/types'

const execFileAsync = promisify(execFile)

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

/** PowerShell 单引号字面量转义（'' 转义 '） */
function psq(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * 本地解压：根据扩展名调用系统命令。
 * - .tar* / .zip：Windows 10+ 自带 tar（bsdtar 支持 zip）
 * - .7z：调用 7z（需安装，PATH 中）
 * - .gz/.bz2/.xz：需要对应工具（Windows 需安装）
 *
 * 通过 execFile 分离参数传递路径，不走 shell 解释，避免文件名中的
 * 引号 / `$()` / 反引号等特殊字符被注入执行。
 */
export async function extract(filePath: string): Promise<void> {
  const lower = filePath.toLowerCase()
  const dir = path.dirname(filePath)
  const isWin = process.platform === 'win32'
  let file: string
  let args: string[]

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    file = 'tar'
    args = ['-xzf', filePath, '-C', dir]
  } else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    file = 'tar'
    args = ['-xjf', filePath, '-C', dir]
  } else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    file = 'tar'
    args = ['-xJf', filePath, '-C', dir]
  } else if (lower.endsWith('.tar')) {
    file = 'tar'
    args = ['-xf', filePath, '-C', dir]
  } else if (lower.endsWith('.zip')) {
    // Windows 优先用 PowerShell Expand-Archive，失败回退 tar
    if (isWin) {
      file = 'powershell.exe'
      args = [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${psq(filePath)}' -DestinationPath '${psq(dir)}' -Force`,
      ]
    } else {
      file = 'unzip'
      args = ['-o', filePath, '-d', dir]
    }
  } else if (lower.endsWith('.7z')) {
    file = '7z'
    args = ['x', filePath, `-o${dir}`, '-y']
  } else if (lower.endsWith('.gz')) {
    if (isWin) {
      file = 'powershell.exe'
      args = [
        '-NoProfile',
        '-Command',
        `$s=[IO.File]::OpenRead('${psq(filePath)}');` +
          `$g=New-Object IO.Compression.GzipStream($s,[IO.Compression.CompressionMode]::Decompress);` +
          `$fs=[IO.File]::Create('${psq(filePath.slice(0, -3))}');` +
          `$g.CopyTo($fs); $fs.Close(); $g.Close()`,
      ]
    } else {
      file = 'gunzip'
      args = ['-k', '-f', filePath]
    }
  } else {
    throw new Error(`不支持的压缩格式：${filePath}`)
  }

  try {
    await execFileAsync(file, args, { windowsHide: true })
  } catch (e: unknown) {
    const err = (e ?? {}) as { stderr?: string; message?: string }
    throw new Error(err.stderr?.trim() || err.message || '解压失败')
  }
}
