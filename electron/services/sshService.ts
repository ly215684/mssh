import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { BrowserWindow } from 'electron'
import type { Connection, ExecResult, SshSessionInfo, SshSettings, SysStats } from '../shared/types'

export interface SshSession {
  id: string
  conn: Client
  stream: ClientChannel | null
  sftp: import('ssh2').SFTPWrapper | null
  info: SshSessionInfo
  connCfg: Connection
  sshSettings: SshSettings
}

const sessions = new Map<string, SshSession>()

function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

export function getSession(id: string): SshSession | undefined {
  return sessions.get(id)
}

function removeAndNotify(id: string) {
  if (sessions.has(id)) {
    sessions.delete(id)
    broadcast('ssh:exit', id)
  }
}

/** 将晦涩的 ssh2 认证错误转换为可操作的提示 */
function humanizeAuthError(err: unknown, cfg: Connection): Error {
  const e = err as { message?: string; level?: string }
  const msg = String(e?.message ?? '')
  if (msg.includes('All configured authentication methods failed')) {
    if (cfg.authType === 'password') {
      return new Error(
        `认证失败：服务器拒绝了登录。\n` +
          `请检查用户名与密码是否正确；若服务器已禁用密码登录（PasswordAuthentication no），请改用私钥认证。\n\n` +
          `${cfg.username}@${cfg.host}:${cfg.port}`,
      )
    }
    return new Error(
      `认证失败：私钥被服务器拒绝。\n` +
        `请确认：1) 公钥已添加到服务器 ~/.ssh/authorized_keys；2) 私钥为 OpenSSH/PEM 格式（不支持 PuTTY 的 .ppk）；3) 私钥口令正确。\n\n` +
        `${cfg.username}@${cfg.host}:${cfg.port}`,
    )
  }
  if (msg.includes('Cannot parse privateKey') || msg.includes('Encrypted private key')) {
    return new Error(
      `无法解析私钥文件。\n` +
        `仅支持 OpenSSH/PEM 格式（PuTTY 的 .ppk 需先用 PuTTYgen 转换为 OpenSSH 格式）；若私钥已加密，请填写正确的私钥口令。\n\n` +
        `详细信息: ${msg}`,
    )
  }
  return err instanceof Error ? err : new Error(msg)
}

/**
 * 建立 SSH 连接并打开交互式 shell。
 * 成功后注册会话，终端输出通过 `ssh:data` 事件推送给渲染进程。
 */
export function connect(cfg: Connection, sshSettings: SshSettings): Promise<SshSessionInfo> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const conn = new Client()
    let settled = false

    const session: SshSession = {
      id,
      conn,
      stream: null,
      sftp: null,
      info: {
        sessionId: id,
        cipher: '',
        kex: '',
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
      },
      connCfg: cfg,
      sshSettings,
    }

    conn.on('handshake', neg => {
      session.info.cipher = String(neg.cs.cipher)
      session.info.kex = String(neg.kex)
    })

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          conn.end()
          if (!settled) {
            settled = true
            reject(err)
          }
          return
        }
        session.stream = stream

        // StringDecoder 处理跨包截断的多字节字符
        const decoder = new StringDecoder('utf8')
        stream.on('data', (d: Buffer) => {
          broadcast('ssh:data', id, decoder.write(d))
        })
        stream.on('close', () => {
          conn.end()
          removeAndNotify(id)
        })

        sessions.set(id, session)
        if (!settled) {
          settled = true
          resolve(session.info)
        }
      })
    })

    conn.on('error', err => {
      if (!settled) {
        settled = true
        reject(humanizeAuthError(err, cfg))
      }
      removeAndNotify(id)
    })
    conn.on('close', () => removeAndNotify(id))

    const connectCfg: ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: sshSettings.connectTimeout * 1000,
      keepaliveInterval:
        sshSettings.keepaliveInterval > 0 ? sshSettings.keepaliveInterval * 1000 : 0,
      // 允许连续丢失 5 次心跳才判定断线（默认 3 次），短暂网络抖动不轻易断开
      keepaliveCountMax: 5,
      algorithms: {
        compress: sshSettings.compression ? ['zlib@openssh.com', 'zlib', 'none'] : undefined,
      },
    }

    try {
      if (cfg.authType === 'password') {
        connectCfg.password = cfg.password
        // 服务器仅开启 keyboard-interactive（PAM）时自动回填密码重试
        connectCfg.tryKeyboard = true
      } else {
        connectCfg.privateKey = fs.readFileSync(cfg.privateKeyPath ?? '', 'utf8')
        if (cfg.keyPassphrase) connectCfg.passphrase = cfg.keyPassphrase
      }
    } catch (e) {
      reject(humanizeAuthError(new Error(`无法读取私钥文件: ${(e as Error).message}`), cfg))
      return
    }

    // keyboard-interactive 应答：密码认证回填密码，私钥认证回填私钥口令
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const answer = cfg.authType === 'password' ? (cfg.password ?? '') : (cfg.keyPassphrase ?? '')
      finish(prompts.map(() => answer))
    })

    conn.connect(connectCfg)
  })
}

export function write(sessionId: string, data: string) {
  sessions.get(sessionId)?.stream?.write(data)
}

export function resize(sessionId: string, cols: number, rows: number) {
  sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
}

export function disconnect(sessionId: string) {
  const s = sessions.get(sessionId)
  if (s) {
    sessions.delete(sessionId)
    s.conn.end()
  }
}

export function isConnected(connectionId: string): boolean {
  for (const s of sessions.values()) {
    if (s.connCfg.id === connectionId) return true
  }
  return false
}

/** 通过 SSH 会话执行命令，返回 stdout 文本（非交互模式） */
export function exec(sessionId: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId)
    if (!session) return reject(new Error('SSH session not found'))
    session.conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      const dec = new StringDecoder('utf8')
      stream.on('data', (d: Buffer) => {
        out += dec.write(d)
      })
      stream.stderr.on('data', () => {
        // 该辅助函数仅消费 stdout，stderr 直接丢弃
      })
      stream.on('close', () => {
        out += dec.end()
        resolve(out)
      })
    })
  })
}

/** 通过 SSH 执行一次性命令，返回完整结果（stdout/stderr/退出码） */
export function execCommand(sessionId: string, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId)
    if (!session) return reject(new Error('SSH session not found'))
    session.conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      const dec = new StringDecoder('utf8')
      const errDec = new StringDecoder('utf8')
      stream.on('data', (d: Buffer) => {
        stdout += dec.write(d)
      })
      stream.stderr.on('data', (d: Buffer) => {
        stderr += errDec.write(d)
      })
      stream.on('close', (code: number | null) => {
        stdout += dec.end()
        stderr += errDec.end()
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })
  })
}

/** 流式命令条目：长任务（docker logs -f / compose up）的通道 */
interface StreamEntry {
  channel: ClientChannel
}
const streams = new Map<string, StreamEntry>()

/**
 * 启动流式命令，返回 streamId。
 * 输出通过 `ssh:stream:data` 事件广播（streamId, data, kind），
 * 结束通过 `ssh:stream:close` 事件广播（streamId, code）。
 */
export function execStream(sessionId: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId)
    if (!session) return reject(new Error('SSH session not found'))
    session.conn.exec(command, (err, channel) => {
      if (err) return reject(err)
      const streamId = randomUUID()
      const dec = new StringDecoder('utf8')
      const errDec = new StringDecoder('utf8')
      channel.on('data', (d: Buffer) => {
        broadcast('ssh:stream:data', streamId, dec.write(d), 'stdout')
      })
      channel.stderr.on('data', (d: Buffer) => {
        broadcast('ssh:stream:data', streamId, errDec.write(d), 'stderr')
      })
      channel.on('close', (code: number | null) => {
        streams.delete(streamId)
        const tail = dec.end()
        if (tail) broadcast('ssh:stream:data', streamId, tail, 'stdout')
        broadcast('ssh:stream:close', streamId, code ?? 0)
      })
      streams.set(streamId, { channel })
      resolve(streamId)
    })
  })
}

/** 终止流式命令（关闭通道，远端进程收到 SIGHUP） */
export function killStream(streamId: string) {
  const entry = streams.get(streamId)
  if (!entry) return
  streams.delete(streamId)
  try {
    entry.channel.signal('TERM')
  } catch {
    // 部分服务器不支持 signal 请求，直接关闭通道即可
  }
  entry.channel.close()
}

/** 解析 /proc/stat 的 cpu 行，返回 [busy, total] */
function parseCpuLine(line: string): [number, number] {
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts
  const idleTotal = idle + iowait
  const total = user + nice + system + idle + iowait + irq + softirq + (steal ?? 0)
  return [total - idleTotal, total]
}

/**
 * 获取远程服务器资源占用。
 * 策略：两次采样 /proc/stat（间隔 1s）算实时 CPU，同时取 /proc/meminfo 与 df。
 */
export async function getSysStats(sessionId: string): Promise<SysStats> {
  const output = await exec(
    sessionId,
    "head -1 /proc/stat; sleep 1; head -1 /proc/stat; " +
      "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; " +
      "df -B1 / | tail -1",
  )
  const lines = output.split('\n').filter(Boolean)

  const [busy1, total1] = parseCpuLine(lines[0])
  const [busy2, total2] = parseCpuLine(lines[1])
  const cpu = total2 === total1 ? 0 : Math.min(100, ((busy2 - busy1) / (total2 - total1)) * 100)

  let memTotal = 0
  let memAvailable = 0
  for (let i = 2; i < lines.length; i++) {
    const m = lines[i].match(/^(MemTotal|MemAvailable):\s+(\d+)/)
    if (!m) continue
    const kb = Number(m[2])
    if (m[1] === 'MemTotal') memTotal = kb
    else memAvailable = kb
  }
  const memUsedKB = Math.max(0, memTotal - memAvailable)
  const mem = memTotal > 0 ? (memUsedKB / memTotal) * 100 : 0

  // df 输出在命令末尾，取最后一行即可（已用 tail -1 保证只有一行数据）
  const diskLine = lines[lines.length - 1]
  let disk = 0
  let diskTotal = 0
  let diskUsed = 0
  if (diskLine) {
    const parts = diskLine.trim().split(/\s+/)
    diskTotal = Number(parts[1]) || 0
    diskUsed = Number(parts[2]) || 0
    disk = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0
  }

  return {
    cpu: Math.round(cpu),
    mem: Math.round(mem),
    memUsed: Math.round(memUsedKB / 1024),
    memTotal: Math.round(memTotal / 1024),
    disk: Math.round(disk),
    diskUsed: Math.round((diskUsed / 1024 / 1024 / 1024) * 10) / 10,
    diskTotal: Math.round((diskTotal / 1024 / 1024 / 1024) * 10) / 10,
  }
}
