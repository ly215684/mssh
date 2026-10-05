import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { BrowserWindow } from 'electron'
import type { Connection, SshSessionInfo, SshSettings } from '../shared/types'

/**
 * Telnet 会话服务：基于 node:net 自实现 RFC 854 IAC 选项协商。
 * 会话 API 与 sshService 对称，事件复用 ssh:data / ssh:exit 通道，
 * 渲染进程终端、断线重连逻辑无需区分协议。
 */
export interface TelnetSession {
  id: string
  socket: net.Socket
  info: SshSessionInfo
  connCfg: Connection
  /** 终端尺寸（NAWS 协商成功后上报给服务器） */
  cols: number
  rows: number
  /** 服务器已请求 NAWS（收到 DO NAWS 后才允许上报尺寸） */
  nawsAccepted: boolean
}

const sessions = new Map<string, TelnetSession>()

/** 会话关闭钩子（与 sshService 相同的机制，供依赖方注册清理逻辑） */
type SessionCloseHook = (sessionId: string) => void
const closeHooks: SessionCloseHook[] = []

/** 注册会话关闭回调；断开/出错时触发 */
export function onSessionClosed(cb: SessionCloseHook): void {
  closeHooks.push(cb)
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

export function getSession(id: string): TelnetSession | undefined {
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
    return '连接被拒绝：目标主机未开放 Telnet 端口'
  }
  return msg || '连接已断开'
}

/**
 * 会话退出并广播（复用 ssh:exit 通道，前端断线页/自动重连直接生效）。
 * reason 以先到达者为准（error 先于 close），避免具体错误被默认原因覆盖。
 */
const exitReasons = new Map<string, string>()
function removeAndNotify(id: string, reason?: string) {
  if (reason && !exitReasons.has(id)) exitReasons.set(id, reason)
  if (sessions.has(id)) {
    sessions.delete(id)
    const why = exitReasons.get(id) ?? '连接已断开'
    console.warn(`[telnet] session exit: ${id.slice(0, 8)}… reason: ${why}`)
    for (const h of closeHooks) {
      try {
        h(id)
      } catch {
        // 钩子失败不影响断开流程
      }
    }
    broadcast('ssh:exit', id, why)
  }
  if (!sessions.has(id)) exitReasons.delete(id)
}

/* ---------------- Telnet 协议常量（RFC 854） ---------------- */
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240
/** 选项：回显 / 抑制前进信号 / 终端类型 / 窗口大小 */
const OPT_ECHO = 1
const OPT_SGA = 3
const OPT_TTYPE = 24
const OPT_NAWS = 31
/** TTYPE 子协商命令 */
const TTYPE_IS = 0
const TTYPE_SEND = 1

const TERMINAL_TYPE = 'xterm-256color'

/**
 * 入站 IAC 解析器：剥离协商序列并自动应答，产出纯终端数据。
 * 支持的选项：ECHO / SGA（接受服务端 WILL），TTYPE / NAWS（接受服务端 DO），
 * 其余一律拒绝；子协商仅应答 TTYPE SEND。
 */
class TelnetParser {
  /** 已应答 DO 的服务端选项（避免重复应答） */
  private readonly agreedWill = new Set<number>()
  /** 已应答 WILL 的本地选项 */
  private readonly agreedDo = new Set<number>()

  constructor(
    private readonly socket: net.Socket,
    private readonly onData: (chunk: Buffer) => void,
    private readonly onNawsAccepted: () => void,
  ) {}

  private send(...bytes: number[]) {
    this.socket.write(Buffer.from(bytes))
  }

  /** 喂入一段 TCP 数据（假设不与上一包做跨包 IAC 拼接的极简处理：先缓存残留） */
  private pending: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer) {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    const out: Buffer[] = []
    let start = 0
    let i = 0
    while (i < buf.length) {
      if (buf[i] !== IAC) {
        i++
        continue
      }
      // 找到 IAC：先把之前的数据段收进 out
      if (i > start) out.push(buf.subarray(start, i))
      if (i + 1 >= buf.length) {
        // IAC 是包尾，留到下一包处理
        this.pending = buf.subarray(i)
        break
      }
      const cmd = buf[i + 1]
      if (cmd === IAC) {
        // IAC IAC → 字面 0xFF
        out.push(Buffer.from([IAC]))
        i += 2
        start = i
        continue
      }
      if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
        if (i + 2 >= buf.length) {
          this.pending = buf.subarray(i)
          break
        }
        this.handleNegotiation(cmd, buf[i + 2])
        i += 3
        start = i
        continue
      }
      if (cmd === SB) {
        // 子协商：找到 IAC SE 结束
        let j = i + 2
        let end = -1
        while (j + 1 < buf.length) {
          if (buf[j] === IAC && buf[j + 1] === SE) {
            end = j
            break
          }
          j++
        }
        if (end === -1) {
          // 子协商未收完，整体留到下一包
          this.pending = buf.subarray(i)
          break
        }
        this.handleSub(buf.subarray(i + 2, end))
        i = end + 2
        start = i
        continue
      }
      // 其他双字节命令（NOP/GA 等）：直接跳过
      i += 2
      start = i
    }
    if (this.pending.length === 0 && start < buf.length) out.push(buf.subarray(start))
    if (out.length) this.onData(Buffer.concat(out))
  }

  private handleNegotiation(cmd: number, opt: number) {
    if (cmd === WILL) {
      // 服务端回显 / 抑制 GA：接受；其余拒绝
      if (opt === OPT_ECHO || opt === OPT_SGA) {
        if (!this.agreedWill.has(opt)) {
          this.agreedWill.add(opt)
          this.send(IAC, DO, opt)
        }
      } else {
        this.send(IAC, DONT, opt)
      }
      return
    }
    if (cmd === WONT) {
      this.agreedWill.delete(opt)
      return
    }
    if (cmd === DO) {
      // 终端类型 / 窗口大小：接受；其余拒绝
      if (opt === OPT_TTYPE || opt === OPT_NAWS) {
        if (!this.agreedDo.has(opt)) {
          this.agreedDo.add(opt)
          this.send(IAC, WILL, opt)
          if (opt === OPT_NAWS) this.onNawsAccepted()
        }
      } else {
        this.send(IAC, WONT, opt)
      }
      return
    }
    if (cmd === DONT) {
      this.agreedDo.delete(opt)
    }
  }

  /** 子协商：仅应答 TTYPE SEND，其余忽略 */
  private handleSub(payload: Buffer) {
    if (payload.length >= 2 && payload[0] === OPT_TTYPE && payload[1] === TTYPE_SEND) {
      const term = Buffer.from(TERMINAL_TYPE, 'ascii')
      this.socket.write(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_IS]), term, Buffer.from([IAC, SE])]))
    }
  }
}

/** 发送 NAWS 窗口尺寸（0xFF 需转义） */
function sendNaws(socket: net.Socket, cols: number, rows: number) {
  const bytes: number[] = [IAC, SB, OPT_NAWS]
  for (const v of [cols >> 8, cols & 0xff, rows >> 8, rows & 0xff]) {
    bytes.push(v)
    if (v === IAC) bytes.push(IAC)
  }
  bytes.push(IAC, SE)
  socket.write(Buffer.from(bytes))
}

/**
 * 自动登录状态机：配置了 username/password 时，监听登录阶段输出，
 * 尾部匹配 login:/username: 提示则发送用户名，匹配 password: 提示则发送密码。
 * 各只应答一次，应答完毕或超时后停止监听（避免误响应登录后的 passwd/su 提示）。
 */
class AutoLogin {
  private tail = ''
  private needUser: boolean
  private needPass: boolean
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    private readonly username: string | undefined,
    private readonly password: string | undefined,
    private readonly send: (text: string) => void,
  ) {
    this.needUser = !!username
    this.needPass = !!password
    // 最多监听 60 秒；未出现提示则停止（正常交互登录）
    this.timer = setTimeout(() => this.stop(), 60_000)
  }

  feed(text: string) {
    if (!this.needUser && !this.needPass) return
    this.tail = (this.tail + text).slice(-300)
    if (this.needUser && /(?:login|username)\s*[:：]?\s*$/i.test(this.tail)) {
      this.needUser = false
      this.tail = ''
      this.send(`${this.username}\r`)
      return
    }
    if (this.needPass && /pass(?:word|code)?\s*[:：]?\s*$/i.test(this.tail)) {
      this.needPass = false
      this.tail = ''
      this.send(`${this.password}\r`)
    }
  }

  stop() {
    this.needUser = false
    this.needPass = false
    clearTimeout(this.timer)
  }
}

/**
 * 建立 Telnet 连接。TCP 连通即视为成功（登录在终端交互/自动登录完成），
 * 终端输出通过 `ssh:data` 事件推送给渲染进程。
 */
export function connect(cfg: Connection, sshSettings: SshSettings): Promise<SshSessionInfo> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = new net.Socket()
    let settled = false

    const session: TelnetSession = {
      id,
      socket,
      info: {
        sessionId: id,
        cipher: '',
        kex: '',
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
      },
      connCfg: cfg,
      cols: 80,
      rows: 24,
      nawsAccepted: false,
    }

    const decoder = new StringDecoder('utf8')

    /** 出站：CR 规范化为 CR LF（telnet 行结束约定），0xFF 转义 */
    const sendData = (text: string) => {
      const normalized = text.replace(/\r(?!\n)/g, '\r\n')
      let buf = Buffer.from(normalized, 'utf8')
      if (buf.includes(IAC)) {
        const escaped: number[] = []
        for (const b of buf) {
          escaped.push(b)
          if (b === IAC) escaped.push(IAC)
        }
        buf = Buffer.from(escaped)
      }
      socket.write(buf)
    }
    socketWrites.set(id, sendData)

    // 自动登录（仅在配置了凭据时启用）
    const autoLogin =
      cfg.username || cfg.password ? new AutoLogin(cfg.username, cfg.password, sendData) : null

    const parser = new TelnetParser(
      socket,
      chunk => {
        const text = decoder.write(chunk)
        autoLogin?.feed(text)
        broadcast('ssh:data', id, text)
      },
      () => {
        // 收到 DO NAWS：立即上报当前尺寸
        session.nawsAccepted = true
        sendNaws(socket, session.cols, session.rows)
      },
    )

    socket.on('data', chunk => parser.feed(chunk))
    socket.on('error', err => {
      autoLogin?.stop()
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new Error(humanizeExitReason(err)))
      }
      removeAndNotify(id, humanizeExitReason(err))
    })
    socket.on('close', () => {
      autoLogin?.stop()
      socketWrites.delete(id)
      removeAndNotify(id)
    })

    // 连接建立超时（仅连接阶段生效，连上后清除）
    socket.setTimeout(sshSettings.connectTimeout * 1000)
    socket.once('timeout', () => {
      socket.destroy()
      if (!settled) {
        settled = true
        reject(new Error(`连接超时：${cfg.host}:${cfg.port} 在 ${sshSettings.connectTimeout}s 内无响应`))
      }
      removeAndNotify(id, '连接超时：服务器长时间无响应')
    })

    socket.connect(cfg.port, cfg.host, () => {
      socket.setTimeout(0)
      socket.setNoDelay(true)
      if (sshSettings.keepaliveInterval > 0) {
        socket.setKeepAlive(true, sshSettings.keepaliveInterval * 1000)
      }
      sessions.set(id, session)
      if (!settled) {
        settled = true
        resolve(session.info)
      }
    })
  })
}

/** sessionId → 出站写入函数（write 需要 IAC 转义与 CR 规范化，由 connect 注入） */
const socketWrites = new Map<string, (text: string) => void>()

export function write(sessionId: string, data: string) {
  socketWrites.get(sessionId)?.(data)
}

export function resize(sessionId: string, cols: number, rows: number) {
  const s = sessions.get(sessionId)
  if (!s) return
  s.cols = cols
  s.rows = rows
  // NAWS 协商成功后每次尺寸变化都上报
  if (s.nawsAccepted) sendNaws(s.socket, cols, rows)
}

export function disconnect(sessionId: string) {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  socketWrites.delete(sessionId)
  for (const h of closeHooks) {
    try {
      h(sessionId)
    } catch {
      // 钩子失败不影响断开流程
    }
  }
  // end() 发送 FIN；对端不回应时由进程退出兜底
  s.socket.end()
}

/** 断开所有 Telnet 会话（应用退出时调用） */
export function disconnectAll(): void {
  for (const id of [...sessions.keys()]) disconnect(id)
}

export function isConnected(connectionId: string): boolean {
  for (const s of sessions.values()) {
    if (s.connCfg.id === connectionId) return true
  }
  return false
}
