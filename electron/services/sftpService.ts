import type { SFTPWrapper } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { FileInfo, TransferItem } from '../shared/types'
import { getSession, type SshSession } from './sshService'
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

/** 上传：支持文件与目录（递归），同一会话内串行执行 */
export async function upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string[]> {
  const session = asSession(sessionId)
  if (!session) throw new Error('SSH 会话不存在或已断开')
  await getSftp(sessionId)

  const ids: string[] = []
  for (const lp of localPaths) {
    const st = await fsp.stat(lp)
    const id = randomUUID()
    transfers.set(id, {
      id,
      direction: 'upload',
      connectionId: session.connCfg.id,
      localPath: lp,
      remotePath: joinRemote(remoteDir, path.basename(lp)),
      name: path.basename(lp),
      size: st.size,
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
      try {
        await uploadEntry(sessionId, item, item.localPath, item.remotePath)
      } catch (e) {
        item.status = 'error'
        item.error = (e as Error).message
        emitTransfer(item)
      }
    }
  })

  return ids
}

async function uploadEntry(sessionId: string, item: TransferItem, localPath: string, remotePath: string) {
  const sftp = await getSftp(sessionId)
  const st = await fsp.stat(localPath)

  if (st.isDirectory()) {
    await ensureRemoteDir(sftp, remotePath)
    const children = await fsp.readdir(localPath)
    for (const child of children) {
      await uploadEntry(sessionId, item, path.join(localPath, child), joinRemote(remotePath, child))
    }
    return
  }

  item.status = 'active'
  emitTransfer(item)

  let lastTs = Date.now()
  let lastBytes = 0
  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (sent: number, _chunk: number, total: number) => {
        item.size = total
        item.transferred = sent
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

  item.transferred = item.size
  item.speed = 0
  item.status = 'done'
  emitTransfer(item)
}

/** 下载：支持文件与目录（递归） */
export async function download(sessionId: string, remotePaths: string[], localDir: string): Promise<string[]> {
  const session = asSession(sessionId)
  if (!session) throw new Error('SSH 会话不存在或已断开')
  await getSftp(sessionId)

  const ids: string[] = []
  for (const rp of remotePaths) {
    const id = randomUUID()
    transfers.set(id, {
      id,
      direction: 'download',
      connectionId: session.connCfg.id,
      localPath: path.join(localDir, basenameRemote(rp)),
      remotePath: rp,
      name: basenameRemote(rp),
      size: 0,
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
      try {
        await downloadEntry(sessionId, item, item.remotePath, item.localPath)
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

async function downloadEntry(sessionId: string, item: TransferItem, remotePath: string, localPath: string) {
  const sftp = await getSftp(sessionId)
  const isDir = await new Promise<boolean>((resolve, reject) => {
    sftp.lstat(remotePath, (err, stats) => (err ? reject(err) : resolve(stats.isDirectory())))
  })

  if (isDir) {
    await fsp.mkdir(localPath, { recursive: true })
    const entries = await new Promise<{ filename: string }[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)))
    })
    for (const e of entries) {
      await downloadEntry(
        sessionId,
        item,
        joinRemote(remotePath, e.filename),
        path.join(localPath, e.filename),
      )
    }
    return
  }

  const size = await new Promise<number>((resolve, reject) => {
    sftp.lstat(remotePath, (err, stats) => (err ? reject(err) : resolve(Number(stats.size))))
  })
  item.size = size
  item.status = 'active'
  emitTransfer(item)

  let lastTs = Date.now()
  let lastBytes = 0
  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {
      step: (sent: number, _chunk: number, total: number) => {
        item.size = total
        item.transferred = sent
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

  item.transferred = item.size
  item.speed = 0
  item.status = 'done'
  emitTransfer(item)
}

export { remoteExists }
