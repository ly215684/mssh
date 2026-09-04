import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { BrowserWindow } from 'electron'
import type { Connection, SshSessionInfo, SshSettings } from '../shared/types'

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
