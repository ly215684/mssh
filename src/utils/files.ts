import { FileArchive, FileImage, FileText, Folder, File, type LucideIcon } from 'lucide-react'
import type { FileInfo } from '../../electron/shared/types'

export type FilterKey = 'all' | 'docs' | 'images' | 'archives'

const DOC_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'log', 'json', 'xml', 'html', 'htm', 'yml', 'yaml', 'conf', 'ini', 'sh',
])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'])
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'txz', 'zst'])

/** 是否为可解压的压缩包 */
export function isArchive(name: string): boolean {
  const lower = name.toLowerCase()
  if (ARCHIVE_EXTS.has(extOf(lower))) return true
  return lower.endsWith('.tar.gz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tar.xz')
}
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function matchFilter(f: FileInfo, filter: FilterKey): boolean {
  if (filter === 'all') return true
  if (f.isDir) return true
  const ext = extOf(f.name)
  if (filter === 'docs') return DOC_EXTS.has(ext)
  if (filter === 'images') return IMAGE_EXTS.has(ext)
  return ARCHIVE_EXTS.has(ext)
}

export function fileIcon(f: FileInfo): LucideIcon {
  if (f.isDir) return Folder
  const ext = extOf(f.name)
  if (IMAGE_EXTS.has(ext)) return FileImage
  if (ARCHIVE_EXTS.has(ext)) return FileArchive
  if (DOC_EXTS.has(ext)) return FileText
  return File
}

export function fileIconCls(f: FileInfo): string {
  if (f.isDir) return 'text-accent'
  const ext = extOf(f.name)
  if (IMAGE_EXTS.has(ext)) return 'text-info'
  if (ARCHIVE_EXTS.has(ext)) return 'text-warning'
  return 'text-dim'
}

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatSpeed(bps: number): string {
  return `${formatSize(bps)}/s`
}

/** 跨平台父目录（处理 win32 盘符根与 posix 根） */
export function parentPath(p: string): string | null {
  const isWinDrive = /^[a-zA-Z]:\\?$/.test(p)
  if (p === '/' || isWinDrive) return null
  if (p.includes('\\')) {
    const trimmed = p.replace(/\\+$/, '')
    const idx = trimmed.lastIndexOf('\\')
    if (idx <= 2) return trimmed.slice(0, 3)
    return trimmed.slice(0, idx)
  }
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/** 跨平台路径拼接 */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  if (dir.endsWith(sep)) return dir + name
  return dir + sep + name
}

/** 从路径取文件名 */
export function baseName(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/'
  return p.split(sep).filter(Boolean).pop() ?? p
}
