import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { WebSocketServer, WebSocket } from 'ws'
import type { Connection, SshSessionInfo, SshSettings } from '../shared/types'

/**
 * VNC 会话服务：noVNC（渲染进程）只能连 WebSocket，无法直连 VNC 服务器的裸 TCP，
 * 因此在主进程为每个会话起一个绑定 127.0.0.1 随机端口的 WebSocket→TCP 桥。
 * RFB 协议握手/认证/编码全部由渲染进程的 noVNC 完成，本服务只做字节透传。
 * 会话生命周期复用 ssh:exit 事件通道（与 telnetService 同模式），
 * 渲染进程的断线页/自动重连/关标签断开逻辑无需区分协议。
 */
export interface VncSession {
  id: string
  socket: net.Socket
  wss: WebSocketServer
  /** 已接入的 WS 客户端（仅允许一个；未接入时为 null） */
  ws: WebSocket | null
  info: SshSessionInfo
  connCfg: Connection
}

const sessions = new Map<string, VncSession>()

function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

export function getSession(id: string): VncSession | undefined {
  return sessions.get(id)
}

export function has(id: string): boolean {
  return sessions.has(id)
}

/** 将 socket 错误转成用户可读的断开原因 */
function humanizeExitReason(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? '')
  const code = String((err as { code?: string })?.code ?? '')
  if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
    return '连接被重置：对端或中间网络设备中断了 TCP 连接'
  }
  if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT')) return '网络超时：数据无法到达服务器'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达'
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return '连接被拒绝：目标主机未开放 VNC 端口'
  }
  return msg || '连接已断开'
}

/** 关闭桥的所有资源（幂等） */
function teardown(s: VncSession) {
  try {
    s.ws?.close()
  } catch {
    // 已关闭时忽略
  }
  try {
    s.wss.close()
  } catch {
    // 已关闭时忽略
  }
  s.socket.destroy()
}

/**
 * 会话退出并广播（复用 ssh:exit 通道，前端断线页/自动重连直接生效）。
 * reason 以先到达者为准（error 先于 close），避免具体错误被默认原因覆盖。
 */
const exitReasons = new Map<string, string>()
function removeAndNotify(id: string, reason?: string) {
  if (reason && !exitReasons.has(id)) exitReasons.set(id, reason)
  const s = sessions.get(id)
  if (s) {
    sessions.delete(id)
    teardown(s)
    const why = exitReasons.get(id) ?? '连接已断开'
    console.warn(`[vnc] session exit: ${id.slice(0, 8)}… reason: ${why}`)
    broadcast('ssh:exit', id, why)
  }
  if (!sessions.has(id)) exitReasons.delete(id)
}

/**
 * 建立 VNC 桥接会话。先直连 VNC 服务器 TCP（尽早暴露 ECONNREFUSED 等错误），
 * 成功后挂起 socket（RFB 服务器会立即推送版本串，等 WS 客户端接入后再放行），
 * 再起 WS 服务并把 wsUrl 交给渲染进程的 noVNC。
 */
export function connect(cfg: Connection, sshSettings: SshSettings): Promise<SshSessionInfo> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = new net.Socket()
    let settled = false

    const fail = (err: unknown) => {
      socket.destroy()
      if (!settled) {
        settled = true
        reject(new Error(humanizeExitReason(err)))
      }
      removeAndNotify(id, humanizeExitReason(err))
    }

    socket.on('error', fail)

    // 连接建立超时（仅连接阶段生效，连上后清除）
    socket.setTimeout(sshSettings.connectTimeout * 1000)
    socket.once('timeout', () => {
      fail(new Error(`连接超时：${cfg.host}:${cfg.port} 在 ${sshSettings.connectTimeout}s 内无响应`))
    })

    socket.connect(cfg.port, cfg.host, () => {
      socket.setTimeout(0)
      socket.setNoDelay(true)
      if (sshSettings.keepaliveInterval > 0) {
        socket.setKeepAlive(true, sshSettings.keepaliveInterval * 1000)
      }
      // 挂起 TCP：RFB 服务器连上即推 "RFB 003.008\n"，等 noVNC 的 WS 接入后再 resume
      socket.pause()

      // 每会话一个 WS 服务，仅绑定回环地址 + 随机端口
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024 })
      wss.on('error', err => fail(err))
      wss.on('listening', () => {
        const addr = wss.address()
        if (!addr || typeof addr === 'string') {
          fail(new Error('WS 桥启动失败：无法获取监听端口'))
          return
        }
        const session: VncSession = {
          id,
          socket,
          wss,
          ws: null,
          info: {
            sessionId: id,
            cipher: '',
            kex: '',
            host: cfg.host,
            port: cfg.port,
            username: '',
            wsUrl: `ws://127.0.0.1:${addr.port}`,
          },
          connCfg: cfg,
        }
        sessions.set(id, session)
        if (!settled) {
          settled = true
          resolve(session.info)
        }
      })

      // 仅接受一个客户端（noVNC）；重复接入直接拒绝
      wss.on('connection', ws => {
        const s = sessions.get(id)
        if (!s || s.ws) {
          ws.close()
          return
        }
        s.ws = ws
        ws.binaryType = 'nodebuffer'
        // WS → TCP
        ws.on('message', (data: Buffer) => socket.write(data))
        // TCP → WS（先注册监听器再 resume，避免 pause 期间缓存的数据在无监听器时流失）
        socket.on('data', chunk => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
        })
        socket.resume()
        ws.on('close', () => removeAndNotify(id, '渲染端已断开'))
        ws.on('error', () => removeAndNotify(id, 'WS 桥接通道异常'))
      })

      socket.on('error', err => removeAndNotify(id, humanizeExitReason(err)))
      socket.on('close', () => removeAndNotify(id))
    })
  })
}

export function disconnect(sessionId: string) {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  teardown(s)
  // 与 telnetService.disconnect 一致：主动断开不广播 ssh:exit（渲染端已自行清理）
}

/** 断开所有 VNC 会话（应用退出时调用） */
export function disconnectAll(): void {
  for (const id of [...sessions.keys()]) disconnect(id)
}

export function isConnected(connectionId: string): boolean {
  for (const s of sessions.values()) {
    if (s.connCfg.id === connectionId) return true
  }
  return false
}
