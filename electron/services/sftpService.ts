import type { SFTPWrapper } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { FileInfo, TransferItem } from '../shared/types'
import { exec, getSession, onSessionClosed, type SshSession } from './sshService'
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

/** 用户主动取消 */
class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

/** 传输控制块：取消标志 + 中止入口 + 看门狗时间戳 */
interface TransferCtl {
  sessionId: string
  cancelled: boolean
  /** 最后一次分块完成的时间戳（无进展超时判定） */
  lastProgress: number
  /** 引擎运行中可调用：立即中断传输（取消/超时/连接断开） */
  abort: ((err: Error) => void) | null
}
const ctls = new Map<string, TransferCtl>()

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

/**
 * 看门狗：连接静默断开时 SFTP 请求永远得不到响应（无错误也无进展），
 * 定期检查无进展的活动任务并中止，避免任务永久卡在"传输中"。
 */
const WATCHDOG_MS = 30_000
setInterval(() => {
  const now = Date.now()
  for (const ctl of ctls.values()) {
    if (ctl.abort && now - ctl.lastProgress > WATCHDOG_MS) {
      ctl.abort(new Error('传输无响应，连接可能已中断'))
    }
  }
}, 5000)

/** SSH 会话关闭时，立即中断该会话的所有传输任务 */
onSessionClosed(sessionId => {
  for (const ctl of ctls.values()) {
    if (ctl.sessionId === sessionId && ctl.abort) {
      ctl.abort(new Error('SSH 连接已断开，传输中断'))
    }
  }
})

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

function newCtl(sessionId: string): TransferCtl {
  return { sessionId, cancelled: false, lastProgress: Date.now(), abort: null }
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
    ctls.set(id, newCtl(sessionId))
    ids.push(id)
    emitTransfer(transfers.get(id)!)
  }

  enqueue(sessionId, () => runQueue(sessionId, ids, 'upload'))
  return ids
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
    ctls.set(id, newCtl(sessionId))
    ids.push(id)
    emitTransfer(transfers.get(id)!)
  }

  enqueue(sessionId, () => runQueue(sessionId, ids, 'download'))
  return ids
}

/** 队列执行：逐个任务运行，取消/失败不影响后续任务 */
async function runQueue(sessionId: string, ids: string[], direction: 'upload' | 'download') {
  for (const id of ids) {
    const item = transfers.get(id)
    if (!item) continue
    const ctl = ctls.get(id)
    if (ctl?.cancelled) {
      if (item.status !== 'cancelled') {
        item.status = 'cancelled'
        item.speed = 0
        emitTransfer(item)
      }
      continue
    }
    const ctx = { baseTransferred: 0 }
    try {
      if (direction === 'upload') {
        await uploadEntry(sessionId, item, ctx, item.localPath, item.remotePath)
      } else {
        await downloadEntry(sessionId, item, ctx, item.remotePath, item.localPath)
      }
      item.transferred = item.size
      item.speed = 0
      item.status = 'done'
      emitTransfer(item)
    } catch (e) {
      item.speed = 0
      if (e instanceof CancelledError) {
        item.status = 'cancelled'
      } else {
        item.status = 'error'
        item.error = (e as Error).message
      }
      emitTransfer(item)
    } finally {
      ctls.delete(id)
      transfers.delete(id)
    }
  }
}

/** 取消传输：pending 立即标记取消；active 通知引擎中断（引擎回调后标记） */
export function cancelTransfer(id: string): boolean {
  const item = transfers.get(id)
  if (!item) return false
  if (item.status !== 'pending' && item.status !== 'active') return false
  const ctl = ctls.get(id)
  if (ctl) ctl.cancelled = true
  if (item.status === 'pending') {
    item.status = 'cancelled'
    item.speed = 0
    emitTransfer(item)
  } else if (ctl) {
    ctl.abort?.(new CancelledError())
  }
  return true
}

function basenameRemote(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

// ---------- 可取消的管道式传输引擎 ----------

/** 单个 SFTP 读写请求的块大小（与 ssh2 fastXfer 默认一致） */
const CHUNK_SIZE = 32 * 1024
/** 管道并发请求数 */
const PIPELINE = 64

function sftpOpen(sftp: SFTPWrapper, p: string, flags: 'r' | 'w'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(p, flags, (err, handle) => (err ? reject(err) : resolve(handle)))
  })
}

/**
 * 将外部 Promise 与传输中止信号竞争。
 * 中止（取消/看门狗超时/连接断开）可作用于引擎所有阶段，包括 open/lstat/readdir
 * 等在死连接上回调永不触发、且无法自行失败的 SFTP 操作。
 */
function withAbort<T>(p: Promise<T>, ctl: TransferCtl | undefined): Promise<T> {
  if (!ctl) return p
  return new Promise<T>((resolve, reject) => {
    const abortP = new Promise<never>((_, rej) => {
      ctl.abort = err => rej(err)
    })
    abortP.catch(() => {})
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    p.then(v => done(() => resolve(v)), e => done(() => reject(e)))
    abortP.then(() => {}, e => done(() => reject(e)))
  })
}

function sftpClose(sftp: SFTPWrapper, handle: Buffer): void {
  sftp.close(handle, () => {})
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
    const ctl = ctls.get(item.id)
    if (ctl?.cancelled) throw new CancelledError()
    if (ctl) ctl.lastProgress = Date.now()
    await withAbort(ensureRemoteDir(sftp, remotePath), ctl)
    const children = await fsp.readdir(localPath)
    for (const child of children) {
      await uploadEntry(sessionId, item, ctx, path.join(localPath, child), joinRemote(remotePath, child))
    }
    return
  }

  item.status = 'active'
  emitTransfer(item)

  const ctl = ctls.get(item.id)
  if (ctl?.cancelled) throw new CancelledError()
  if (ctl) ctl.lastProgress = Date.now()

  let lastTs = Date.now()
  let lastBytes = 0
  await putFile(sftp, localPath, remotePath, st.size, ctl, sent => {
    item.transferred = ctx.baseTransferred + sent
    const now = Date.now()
    if (now - lastTs > 300) {
      const instant = ((sent - lastBytes) * 1000) / (now - lastTs)
      item.speed = item.speed > 0 ? item.speed * 0.6 + instant * 0.4 : instant
      lastTs = now
      lastBytes = sent
      emitTransfer(item)
    }
  })

  ctx.baseTransferred += st.size
  item.transferred = ctx.baseTransferred
}

/**
 * 管道式上传：本地分块读取 + 并发 SFTP write。
 * 相比 fastPut 增加取消支持、进度回调与超时中止能力。
 */
async function putFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  fileSize: number,
  ctl: TransferCtl | undefined,
  onProgress: (sent: number) => void,
): Promise<void> {
  // 排队等待期间不计入看门狗，开始传输时重置
  if (ctl) ctl.lastProgress = Date.now()
  const handle = await withAbort(sftpOpen(sftp, remotePath, 'w'), ctl)
  const fd = await fsp.open(localPath, 'r')
  try {
    await new Promise<void>((resolve, reject) => {
      let offset = 0
      let inFlight = 0
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      if (ctl) ctl.abort = fail
      const pump = () => {
        if (settled) return
        if (ctl?.cancelled) return fail(new CancelledError())
        if (offset >= fileSize) {
          if (inFlight === 0) {
            settled = true
            resolve()
          }
          return
        }
        const pos = offset
        const len = Math.min(CHUNK_SIZE, fileSize - offset)
        offset += len
        inFlight++
        const buf = Buffer.allocUnsafe(len)
        fd.read(buf, 0, len, pos)
          .then(() => {
            if (settled) {
              inFlight--
              return
            }
            sftp.write(handle, buf, 0, len, pos, err => {
              inFlight--
              if (settled) return
              if (err) return fail(err instanceof Error ? err : new Error(String(err)))
              if (ctl) ctl.lastProgress = Date.now()
              onProgress(pos + len)
              pump()
            })
          })
          .catch((err: Error) => {
            inFlight--
            fail(err)
          })
      }
      for (let i = 0; i < PIPELINE; i++) pump()
    })
  } finally {
    if (ctl) ctl.abort = null
    sftpClose(sftp, handle)
    await fd.close().catch(() => {})
  }
}

async function downloadEntry(
  sessionId: string,
  item: TransferItem,
  ctx: { baseTransferred: number },
  remotePath: string,
  localPath: string,
) {
  const sftp = await getSftp(sessionId)
  const ctl0 = ctls.get(item.id)
  if (ctl0?.cancelled) throw new CancelledError()
  if (ctl0) ctl0.lastProgress = Date.now()
  const stats = await withAbort(
    new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.lstat(remotePath, (err, s) => (err ? reject(err) : resolve(s)))
    }),
    ctl0,
  )

  if (stats.isDirectory()) {
    await fsp.mkdir(localPath, { recursive: true })
    const entries = await withAbort(
      new Promise<{ filename: string }[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)))
      }),
      ctl0,
    )
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

  item.status = 'active'
  emitTransfer(item)

  const fileSize = Number(stats.size)
  const ctl = ctl0
  if (ctl?.cancelled) throw new CancelledError()
  if (ctl) ctl.lastProgress = Date.now()

  let lastTs = Date.now()
  let lastBytes = 0
  await getFile(sftp, remotePath, localPath, fileSize, ctl, sent => {
    item.transferred = ctx.baseTransferred + sent
    const now = Date.now()
    if (now - lastTs > 300) {
      const instant = ((sent - lastBytes) * 1000) / (now - lastTs)
      item.speed = item.speed > 0 ? item.speed * 0.6 + instant * 0.4 : instant
      lastTs = now
      lastBytes = sent
      emitTransfer(item)
    }
  })

  ctx.baseTransferred += fileSize
  item.transferred = ctx.baseTransferred
}

/** 管道式下载：并发 SFTP read + 本地按偏移写入 */
async function getFile(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  fileSize: number,
  ctl: TransferCtl | undefined,
  onProgress: (received: number) => void,
): Promise<void> {
  // 排队等待期间不计入看门狗，开始传输时重置
  if (ctl) ctl.lastProgress = Date.now()
  const handle = await withAbort(sftpOpen(sftp, remotePath, 'r'), ctl)
  const fd = await fsp.open(localPath, 'w')
  try {
    await new Promise<void>((resolve, reject) => {
      let offset = 0
      let inFlight = 0
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      if (ctl) ctl.abort = fail
      const pump = () => {
        if (settled) return
        if (ctl?.cancelled) return fail(new CancelledError())
        if (offset >= fileSize) {
          if (inFlight === 0) {
            settled = true
            resolve()
          }
          return
        }
        const pos = offset
        const len = Math.min(CHUNK_SIZE, fileSize - offset)
        offset += len
        inFlight++
        const buf = Buffer.allocUnsafe(len)
        sftp.read(handle, buf, 0, len, pos, (err, bytesRead) => {
          inFlight--
          if (settled) return
          if (err) return fail(err instanceof Error ? err : new Error(String(err)))
          fd.write(buf, 0, bytesRead, pos)
            .then(() => {
              if (settled) return
              if (ctl) ctl.lastProgress = Date.now()
              onProgress(pos + bytesRead)
              pump()
            })
            .catch((werr: Error) => fail(werr))
        })
      }
      for (let i = 0; i < PIPELINE; i++) pump()
    })
  } finally {
    if (ctl) ctl.abort = null
    sftpClose(sftp, handle)
    await fd.close().catch(() => {})
  }
}

export { remoteExists }
