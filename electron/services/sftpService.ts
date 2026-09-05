import type { SFTPWrapper } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { FileInfo, TransferItem } from '../shared/types'
import { exec, getSession, type SshSession } from './sshService'
import { sortEntries } from './localFs'

function asSession(id: string): SshSession | undefined {
  return getSession(id)
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

/** 获取（并缓存）sftp 子系统 */
export function getSftp(sessionId: string): Promise<SFTPWrapper> {
  const session = asSession(sessionId)
  if (!session) return Promise.reject(new Error('SSH 会话不存在或已断开'))
  if (session.sftp) return Promise.resolve(session.sftp)
  return new Promise((resolve, reject) => {
    session.conn.sftp((err, sftp) => {
      if (err) return reject(err)
      session.sftp = sftp
      resolve(sftp)
    })
  })
}

// ---------- 目录操作 ----------

export function list(sessionId: string, dir: string): Promise<FileInfo[]> {
  return getSftp(sessionId).then(
    sftp =>
      new Promise((resolve, reject) => {
        sftp.readdir(dir, (err, entries) => {
          if (err) return reject(err)
          const infos: FileInfo[] = entries.map(e => ({
            name: e.filename,
            path: joinRemote(dir, e.filename),
            isDir: e.attrs.isDirectory(),
            size: Number(e.attrs.size ?? 0),
            mtime: (e.attrs.mtime ?? 0) * 1000,
            mode: e.attrs.mode,
            symlink: e.attrs.isSymbolicLink(),
          }))
          resolve(sortEntries(infos))
        })
      }),
  )
}

export async function mkdir(sessionId: string, dir: string): Promise<void> {
  const sftp = await getSftp(sessionId)
  await ensureRemoteDir(sftp, dir)
}

export function rm(sessionId: string, target: string): Promise<void> {
  return getSftp(sessionId).then(
    sftp =>
      new Promise((resolve, reject) => {
        sftp.lstat(target, (err, stats) => {
          if (err) return reject(err)
          if (stats.isDirectory()) {
            rmRemoteDir(sftp, target).then(resolve, reject)
          } else {
            sftp.unlink(target, e => (e ? reject(e) : resolve()))
          }
        })
      }),
  )
}

async function rmRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  const entries = await new Promise<{ filename: string }[]>((resolve, reject) => {
    sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
  })
  for (const e of entries) {
    const child = joinRemote(dir, e.filename)
    await new Promise<void>((resolve, reject) => {
      sftp.lstat(child, (err, stats) => {
        if (err) return reject(err)
        if (stats.isDirectory()) {
          rmRemoteDir(sftp, child).then(resolve, reject)
        } else {
          sftp.unlink(child, x => (x ? reject(x) : resolve()))
        }
      })
    })
  }
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(dir, err => (err ? reject(err) : resolve()))
  })
}

export function rename(sessionId: string, from: string, to: string): Promise<void> {
  return getSftp(sessionId).then(
    sftp =>
      new Promise((resolve, reject) => {
        sftp.rename(from, to, err => (err ? reject(err) : resolve()))
      }),
  )
}

export function realpath(sessionId: string, p: string): Promise<string> {
  return getSftp(sessionId).then(
    sftp =>
      new Promise((resolve, reject) => {
        sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)))
      }),
  )
}

export async function home(sessionId: string): Promise<string> {
  return realpath(sessionId, '.')
}

// ---------- 文件内容读写（文本编辑） ----------

/** 编辑器允许的最大文件大小（2 MB） */
const EDIT_MAX_BYTES = 2 * 1024 * 1024

/** 判断字节是否可能是二进制（含 NUL 字节） */
function isBinaryBuf(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true
  return false
}

/** 读取远程文件文本内容；过大或二进制时抛自定义错误 */
export function readFile(sessionId: string, remotePath: string): Promise<string> {
  return getSftp(sessionId).then(
    sftp =>
      new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err)
          const size = Number(stats.size ?? 0)
          if (size > EDIT_MAX_BYTES) {
            return reject(
              new Error(`文件过大（${(size / 1024 / 1024).toFixed(1)} MB），超过编辑器上限 2 MB，请用其它方式编辑。`),
            )
          }
          sftp.readFile(remotePath, (e, data) => {
            if (e) return reject(e)
            if (isBinaryBuf(data)) {
              return reject(new Error('该文件为二进制文件，无法用文本编辑器打开。'))
            }
            resolve(data.toString('utf8'))
          })
        })
      }),
  )
}

/** 写入文本到远程文件（覆盖） */
export function writeFile(sessionId: string, remotePath: string, content: string): Promise<void> {
  return getSftp(sessionId).then(
    sftp =>
      new Promise((resolve, reject) => {
        sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), err => (err ? reject(err) : resolve()))
      }),
  )
}

/** 创建空文件（已存在则截断） */
export function touch(sessionId: string, remotePath: string): Promise<void> {
  return writeFile(sessionId, remotePath, '')
}

/** 根据扩展名生成远程解压命令（解压到同目录） */
function remoteExtractCmd(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  const dir = filePath.replace(/\/[^/]+$/, '') || '.'
  const quoted = `'${filePath.replace(/'/g, "'\\''")}'`
  const quotedDir = `'${dir.replace(/'/g, "'\\''")}'`
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return `tar -xzf ${quoted} -C ${quotedDir}`
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return `tar -xjf ${quoted} -C ${quotedDir}`
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return `tar -xJf ${quoted} -C ${quotedDir}`
  if (lower.endsWith('.tar')) return `tar -xf ${quoted} -C ${quotedDir}`
  if (lower.endsWith('.zip')) return `unzip -o ${quoted} -d ${quotedDir}`
  if (lower.endsWith('.7z')) return `7z x ${quoted} -o${quotedDir} -y`
  if (lower.endsWith('.gz')) return `gunzip -k -f ${quoted}`
  if (lower.endsWith('.bz2')) return `bunzip2 -k -f ${quoted}`
  if (lower.endsWith('.xz')) return `unxz -k -f ${quoted}`
  return null
}

/**
 * 远程解压：通过 SSH 执行解压命令（解压到文件所在目录）。
 * 返回命令的 stdout（成功时通常为空）。
 */
export async function extract(sessionId: string, remotePath: string): Promise<string> {
  const cmd = remoteExtractCmd(remotePath)
  if (!cmd) throw new Error(`不支持的压缩格式：${remotePath}`)
  // 2>&1 合并 stderr，便于在命令失败时返回错误信息
  const out = await exec(sessionId, `${cmd} 2>&1`)
  // exec 只返回 stdout，不区分退出码；这里再跑一次带退出码的检查
  const check = await exec(sessionId, `${cmd} >/dev/null 2>&1; echo $?`)
  const code = check.trim()
  if (code !== '0') {
    throw new Error(out.trim() || `解压失败（退出码 ${code}）`)
  }
  return out
}

/** 远程路径拼接（POSIX） */
function joinRemote(dir: string, name: string): string {
  const d = dir === '/' ? '' : dir.replace(/\/+$/, '')
  return `${d}/${name}`
}

/** 递归创建远程目录 */
async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let cur = dir.startsWith('/') ? '' : '.'
  for (const part of parts) {
    cur = cur === '' ? `/${part}` : cur === '.' ? part : `${cur}/${part}`
    const exists = await new Promise<boolean>(resolve => {
      sftp.lstat(cur, err => resolve(!err))
    })
    if (!exists) {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(cur, err => (err ? reject(err) : resolve()))
      })
    }
  }
}

/** 远程条目是否存在 */
function remoteExists(sftp: SFTPWrapper, p: string): Promise<boolean> {
  return new Promise(resolve => {
    sftp.exists(p, exists => resolve(!!exists))
  })
}

// ---------- 传输队列 ----------

const transfers = new Map<string, TransferItem>()
/** 每会话串行执行队列 */
const queues = new Map<string, Promise<void>>()

function enqueue(sessionId: string, task: () => Promise<void>) {
  const prev = queues.get(sessionId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(task)
  next.catch(() => {}).finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId)
  })
  queues.set(sessionId, next)
}

function emitTransfer(item: TransferItem) {
  broadcast('transfer:progress', { ...item })
}

/** 递归计算本地路径总大小（目录内所有文件之和） */
async function calcLocalTotalSize(p: string): Promise<number> {
  const st = await fsp.stat(p)
  if (!st.isDirectory()) return st.size
  let total = 0
  const children = await fsp.readdir(p)
  for (const child of children) {
    total += await calcLocalTotalSize(path.join(p, child))
  }
  return total
}

/** 递归计算远程路径总大小（目录内所有文件之和） */
async function calcRemoteTotalSize(sftp: SFTPWrapper, p: string): Promise<number> {
  const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
    sftp.lstat(p, (err, s) => (err ? reject(err) : resolve(s)))
  })
  if (!stats.isDirectory()) return Number(stats.size)
  const entries = await new Promise<{ filename: string }[]>((resolve, reject) => {
    sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list)))
  })
  let total = 0
  for (const e of entries) {
    total += await calcRemoteTotalSize(sftp, joinRemote(p, e.filename))
  }
  return total
}

/** 上传：支持文件与目录（递归），同一会话内串行执行 */
export async function upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string[]> {
  const session = asSession(sessionId)
  if (!session) throw new Error('SSH 会话不存在或已断开')
  await getSftp(sessionId)

  const ids: string[] = []
  for (const lp of localPaths) {
    const id = randomUUID()
    const size = await calcLocalTotalSize(lp).catch(() => 0)
    transfers.set(id, {
      id,
      direction: 'upload',
      connectionId: session.connCfg.id,
      localPath: lp,
      remotePath: joinRemote(remoteDir, path.basename(lp)),
      name: path.basename(lp),
      size,
      transferred: 0,
      status: 'pending',
      speed: 0,
    })
    ids.push(id)
  }

  enqueue(sessionId, async () => {
    for (const id of ids) {
      const item = transfers.get(id)
      if (!item) continue
      const ctx = { baseTransferred: 0 }
      try {
        await uploadEntry(sessionId, item, ctx, item.localPath, item.remotePath)
        item.transferred = item.size
        item.speed = 0
        item.status = 'done'
        emitTransfer(item)
      } catch (e) {
        item.status = 'error'
        item.error = (e as Error).message
        emitTransfer(item)
      }
    }
  })

  return ids
}

async function uploadEntry(
  sessionId: string,
  item: TransferItem,
  ctx: { baseTransferred: number },
  localPath: string,
  remotePath: string,
) {
  const sftp = await getSftp(sessionId)
  const st = await fsp.stat(localPath)

  if (st.isDirectory()) {
    await ensureRemoteDir(sftp, remotePath)
    const children = await fsp.readdir(localPath)
    for (const child of children) {
      await uploadEntry(sessionId, item, ctx, path.join(localPath, child), joinRemote(remotePath, child))
    }
    return
  }

  item.status = 'active'
  emitTransfer(item)

  const fileSize = st.size
  let lastTs = Date.now()
  let lastBytes = 0
  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (sent: number) => {
        item.transferred = ctx.baseTransferred + sent
        const now = Date.now()
        if (now - lastTs > 300) {
          const instant = ((sent - lastBytes) * 1000) / (now - lastTs)
          item.speed = item.speed > 0 ? item.speed * 0.6 + instant * 0.4 : instant
          lastTs = now
          lastBytes = sent
          emitTransfer(item)
        }
      },
    }, err => (err ? reject(err) : resolve()))
  })

  ctx.baseTransferred += fileSize
  item.transferred = ctx.baseTransferred
}

/** 下载：支持文件与目录（递归） */
export async function download(sessionId: string, remotePaths: string[], localDir: string): Promise<string[]> {
  const session = asSession(sessionId)
  if (!session) throw new Error('SSH 会话不存在或已断开')
  const sftp = await getSftp(sessionId)

  const ids: string[] = []
  for (const rp of remotePaths) {
    const id = randomUUID()
    const size = await calcRemoteTotalSize(sftp, rp).catch(() => 0)
    transfers.set(id, {
      id,
      direction: 'download',
      connectionId: session.connCfg.id,
      localPath: path.join(localDir, basenameRemote(rp)),
      remotePath: rp,
      name: basenameRemote(rp),
      size,
      transferred: 0,
      status: 'pending',
      speed: 0,
    })
    ids.push(id)
  }

  enqueue(sessionId, async () => {
    for (const id of ids) {
      const item = transfers.get(id)
      if (!item) continue
      const ctx = { baseTransferred: 0 }
      try {
        await downloadEntry(sessionId, item, ctx, item.remotePath, item.localPath)
        item.transferred = item.size
        item.speed = 0
        item.status = 'done'
        emitTransfer(item)
      } catch (e) {
        item.status = 'error'
        item.error = (e as Error).message
        emitTransfer(item)
      }
    }
  })

  return ids
}

function basenameRemote(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

async function downloadEntry(
  sessionId: string,
  item: TransferItem,
  ctx: { baseTransferred: number },
  remotePath: string,
  localPath: string,
) {
  const sftp = await getSftp(sessionId)
  const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
    sftp.lstat(remotePath, (err, s) => (err ? reject(err) : resolve(s)))
  })

  if (stats.isDirectory()) {
    await fsp.mkdir(localPath, { recursive: true })
    const entries = await new Promise<{ filename: string }[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)))
    })
    for (const e of entries) {
      await downloadEntry(
        sessionId,
        item,
        ctx,
        joinRemote(remotePath, e.filename),
        path.join(localPath, e.filename),
      )
    }
    return
  }

  const fileSize = Number(stats.size)
  item.status = 'active'
  emitTransfer(item)

  let lastTs = Date.now()
  let lastBytes = 0
  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {
      step: (sent: number) => {
        item.transferred = ctx.baseTransferred + sent
        const now = Date.now()
        if (now - lastTs > 300) {
          const instant = ((sent - lastBytes) * 1000) / (now - lastTs)
          item.speed = item.speed > 0 ? item.speed * 0.6 + instant * 0.4 : instant
          lastTs = now
          lastBytes = sent
          emitTransfer(item)
        }
      },
    }, err => (err ? reject(err) : resolve()))
  })

  ctx.baseTransferred += fileSize
  item.transferred = ctx.baseTransferred
}

export { remoteExists }
