import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import { getSession, onSessionClosed } from './sshService'

/**
 * 交互式命令会话服务：
 * - 基于 ssh2 `exec(command, { pty: true })` 打开独立 PTY 通道（不复用终端 shell / 日志流）
 * - 持续写入 stdin，缓冲 stdout，支持增量读取与全屏程序（top / vim）的屏幕快照
 * - 会话由 MCP 工具驱动，AI 请求结束或 SSH 断开时统一回收
 */

/** 单个 SSH 会话最多允许的交互式会话数 */
const MAX_SESSIONS_PER_SSH = 4
/** 单个会话缓冲上限（字符），超出保留尾部 */
const MAX_BUFFER = 512 * 1024
/** 会话最长存活时间，超时自动关闭 */
const MAX_LIFETIME_MS = 30 * 60 * 1000
/** 判定输出静默的间隔 */
const IDLE_MS = 300

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const DEFAULT_TERM = 'xterm-256color'

/** 名称 → 控制序列 */
const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  'ctrl-l': '\x0c',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
}

export const INTERACTIVE_KEY_NAMES = Object.keys(KEY_SEQUENCES)

export type InteractiveMode = 'delta' | 'screen'

export interface InteractiveStartOptions {
  term?: string
  cols?: number
  rows?: number
  waitMs?: number
}

export interface InteractiveReadResult {
  id: string
  /** delta：新增纯文本；screen：当前屏幕快照 */
  output: string
  running: boolean
  exitCode: number | null
  /** 增量输出是否因超过缓冲上限被截断 */
  truncated: boolean
  mode: InteractiveMode
}

interface InteractiveEntry {
  id: string
  sshSessionId: string
  channel: ClientChannel
  decoder: StringDecoder
  screen: ScreenBuffer
  /** 自上次增量读取以来的原始输出（含 ANSI） */
  pending: string
  pendingTruncated: boolean
  /** 每次收到数据自增，用于判断等待期间是否有新输出 */
  dataSeq: number
  running: boolean
  exitCode: number | null
  lastDataAt: number
  startedAt: number
  lifetimeTimer: ReturnType<typeof setTimeout>
}

const entries = new Map<string, InteractiveEntry>()

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 轻量 VT 屏幕模拟：只实现常见的定位 / 清屏 / 换行，用于 TUI 文本快照 */
class ScreenBuffer {
  private cells: string[][]
  private row = 0
  private col = 0
  private esc: 'none' | 'esc' | 'csi' | 'osc' = 'none'
  private csiBuf = ''
  /** OSC 序列中遇到 ESC，等待后续 `\` 结束 */
  private oscEsc = false

  constructor(
    private readonly cols: number,
    private readonly rows: number,
  ) {
    this.cells = this.blank()
  }

  private blank(): string[][] {
    return Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(' '))
  }

  private clear(): void {
    this.cells = this.blank()
    this.row = 0
    this.col = 0
  }

  private scroll(): void {
    this.cells.shift()
    this.cells.push(Array<string>(this.cols).fill(' '))
    this.row = this.rows - 1
  }

  private clamp(): void {
    if (this.row < 0) this.row = 0
    if (this.row >= this.rows) this.scroll()
    if (this.col < 0) this.col = 0
    if (this.col >= this.cols) this.col = this.cols - 1
  }

  private putChar(ch: string): void {
    if (ch === '\r') {
      this.col = 0
      return
    }
    if (ch === '\n') {
      this.row += 1
      this.col = 0
      if (this.row >= this.rows) this.scroll()
      return
    }
    if (ch === '\b') {
      this.col = Math.max(0, this.col - 1)
      return
    }
    if (ch === '\t') {
      this.col = Math.min(this.cols - 1, this.col + (8 - (this.col % 8)))
      return
    }
    // 其余控制字符（含 BEL）忽略
    if (ch < ' ') return

    this.cells[this.row][this.col] = ch
    this.col += 1
    if (this.col >= this.cols) {
      this.col = 0
      this.row += 1
      if (this.row >= this.rows) this.scroll()
    }
  }

  private applyCsi(final: string, params: string): void {
    const priv = params.startsWith('?')
    const nums = params
      .replace(/[?<>]/g, '')
      .split(';')
      .map(p => (p === '' ? NaN : Number(p)))
    const n = (i: number, def = 1): number => {
      const v = nums[i]
      return Number.isFinite(v) && v > 0 ? v : def
    }

    switch (final) {
      case 'H':
      case 'f':
        this.row = n(0) - 1
        this.col = n(1) - 1
        this.clamp()
        break
      case 'A':
        this.row -= n(0)
        this.clamp()
        break
      case 'B':
        this.row += n(0)
        this.clamp()
        break
      case 'C':
        this.col += n(0)
        this.clamp()
        break
      case 'D':
        this.col -= n(0)
        this.clamp()
        break
      case 'G':
        this.col = n(0) - 1
        this.clamp()
        break
      case 'd':
        this.row = n(0) - 1
        this.clamp()
        break
      case 'J': {
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0
        if (mode === 2 || mode === 3) {
          this.clear()
        } else {
          for (let c = this.col; c < this.cols; c++) this.cells[this.row][c] = ' '
          for (let r = this.row + 1; r < this.rows; r++) this.cells[r].fill(' ')
        }
        break
      }
      case 'K': {
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0
        if (mode === 2) this.cells[this.row].fill(' ')
        else if (mode === 1) for (let c = 0; c <= this.col; c++) this.cells[this.row][c] = ' '
        else for (let c = this.col; c < this.cols; c++) this.cells[this.row][c] = ' '
        break
      }
      case 'h':
      case 'l':
        // 备用屏切换（top / vim 等）：进入或退出时清屏，避免两屏内容叠加
        if (priv && nums.some(v => v === 47 || v === 1047 || v === 1049)) this.clear()
        break
      default:
        // SGR（m）及其余序列忽略
        break
    }
  }

  feed(data: string): void {
    for (const ch of data) {
      if (this.esc === 'osc') {
        if (this.oscEsc && ch === '\\') {
          this.esc = 'none'
          this.oscEsc = false
        } else if (ch === '\x07') {
          this.esc = 'none'
          this.oscEsc = false
        } else {
          this.oscEsc = ch === '\x1b'
        }
        continue
      }
      if (this.esc === 'esc') {
        if (ch === '[') {
          this.esc = 'csi'
          this.csiBuf = ''
        } else if (ch === ']') {
          this.esc = 'osc'
          this.oscEsc = false
        } else {
          this.esc = 'none'
        }
        continue
      }
      if (this.esc === 'csi') {
        if (ch >= '@' && ch <= '~') {
          this.applyCsi(ch, this.csiBuf)
          this.esc = 'none'
          this.csiBuf = ''
        } else {
          this.csiBuf += ch
        }
        continue
      }
      if (ch === '\x1b') {
        this.esc = 'esc'
        continue
      }
      this.putChar(ch)
    }
  }

  snapshot(): string {
    const lines = this.cells.map(row => row.join('').trimEnd())
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    return lines.join('\n')
  }
}

/** 去掉 ANSI/控制序列，并处理 \r 覆盖语义，返回可读纯文本 */
export function toPlainText(raw: string): string {
  const noAnsi = raw
    // OSC：ESC ] ... BEL 或 ESC \
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // CSI：ESC [ 参数 终止符
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, '')
    // 其余单字符 ESC 序列
    // eslint-disable-next-line no-control-regex
    .replace(/[\x1b-\x1f]/g, '')

  const lines = noAnsi.split('\n').map(line => {
    // 回车覆盖：同一行多次 \r 时后段覆盖前段
    let rendered: string[] = []
    for (const seg of line.split('\r')) {
      const chars = rendered
      Array.from(seg).forEach((ch, i) => {
        if (ch < ' ') return
        chars[i] = ch
      })
      rendered = chars
    }
    return rendered.join('').trimEnd()
  })
  return lines.join('\n').trimEnd()
}

function appendOutput(entry: InteractiveEntry, chunk: string): void {
  if (!chunk) return
  entry.dataSeq += 1
  entry.lastDataAt = Date.now()
  entry.screen.feed(chunk)
  entry.pending += chunk
  if (entry.pending.length > MAX_BUFFER) {
    entry.pending = entry.pending.slice(-MAX_BUFFER)
    entry.pendingTruncated = true
  }
}

/** 等待输出静默：至少收到新数据后静默 IDLE_MS，或到达 waitMs 上限 */
function collect(entry: InteractiveEntry, waitMs: number, requireData = false): Promise<void> {
  if (waitMs <= 0) return Promise.resolve()
  const startSeq = entry.dataSeq
  const deadline = Date.now() + waitMs
  return new Promise(resolve => {
    const timer = setInterval(() => {
      const gotData = entry.dataSeq > startSeq
      const idle = Date.now() - entry.lastDataAt >= IDLE_MS
      const done = !entry.running || Date.now() >= deadline || (idle && (!requireData || gotData))
      if (done) {
        clearInterval(timer)
        resolve()
      }
    }, 50)
  })
}

function buildResult(entry: InteractiveEntry, mode: InteractiveMode): InteractiveReadResult {
  let output: string
  let truncated = false
  if (mode === 'screen') {
    output = entry.screen.snapshot()
  } else {
    output = toPlainText(entry.pending)
    truncated = entry.pendingTruncated
    entry.pending = ''
    entry.pendingTruncated = false
  }
  return {
    id: entry.id,
    output,
    running: entry.running,
    exitCode: entry.exitCode,
    truncated,
    mode,
  }
}

function requireEntry(id: string): InteractiveEntry {
  const entry = entries.get(id)
  if (!entry) throw new Error(`交互式会话不存在或已关闭：${id}`)
  return entry
}

/** 关闭并回收会话（同步，不等待输出） */
function destroy(entry: InteractiveEntry, sendCtrlC = true): void {
  clearTimeout(entry.lifetimeTimer)
  entries.delete(entry.id)
  const channel = entry.channel
  if (sendCtrlC && entry.running) {
    try {
      channel.write('\x03')
    } catch {
      /* 通道可能已失效 */
    }
  }
  try {
    channel.signal('TERM')
  } catch {
    /* 部分服务器不支持 signal 请求 */
  }
  try {
    channel.close()
  } catch {
    /* 已关闭 */
  }
  entry.running = false
}

/** 启动交互式命令，返回会话 id 与初始输出 */
export async function startInteractive(
  sshSessionId: string,
  command: string,
  opts: InteractiveStartOptions = {},
): Promise<InteractiveReadResult> {
  const session = getSession(sshSessionId)
  if (!session) throw new Error('SSH session not found')

  const existing = [...entries.values()].filter(e => e.sshSessionId === sshSessionId)
  if (existing.length >= MAX_SESSIONS_PER_SSH) {
    throw new Error(
      `同一 SSH 会话最多同时运行 ${MAX_SESSIONS_PER_SSH} 个交互式会话，请先关闭不再需要的会话`,
    )
  }

  const cols = Math.max(20, Math.min(300, Number(opts.cols) || DEFAULT_COLS))
  const rows = Math.max(5, Math.min(100, Number(opts.rows) || DEFAULT_ROWS))
  const term = opts.term?.trim() || DEFAULT_TERM
  const rawWait = Number(opts.waitMs ?? 800)
  const waitMs = Number.isFinite(rawWait) ? Math.max(0, Math.min(15000, rawWait)) : 800

  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    session.conn.exec(
      command,
      { pty: { term, cols, rows, width: cols * 9, height: rows * 18 } },
      (err, ch) => (err ? reject(err) : resolve(ch)),
    )
  })

  const entry: InteractiveEntry = {
    id: randomUUID(),
    sshSessionId,
    channel,
    decoder: new StringDecoder('utf8'),
    screen: new ScreenBuffer(cols, rows),
    pending: '',
    pendingTruncated: false,
    dataSeq: 0,
    running: true,
    exitCode: null,
    lastDataAt: Date.now(),
    startedAt: Date.now(),
    lifetimeTimer: setTimeout(() => {
      const cur = entries.get(entry.id)
      if (cur) destroy(cur)
    }, MAX_LIFETIME_MS),
  }

  channel.on('data', (d: Buffer) => appendOutput(entry, entry.decoder.write(d)))
  channel.stderr.on('data', (d: Buffer) => appendOutput(entry, entry.decoder.write(d)))
  channel.on('close', (code: number | null) => {
    entry.running = false
    entry.exitCode = code ?? 0
    entry.lastDataAt = Date.now()
    clearTimeout(entry.lifetimeTimer)
  })

  entries.set(entry.id, entry)

  await collect(entry, waitMs, true)
  return buildResult(entry, 'delta')
}

/** 向交互式会话写入文本 / 按键，返回新增输出 */
export async function sendInteractive(
  id: string,
  text = '',
  keys: string[] = [],
  waitMs = 800,
): Promise<InteractiveReadResult> {
  const entry = requireEntry(id)
  if (!entry.running) {
    throw new Error(`交互式会话已结束（退出码 ${entry.exitCode ?? '未知'}），无法继续输入`)
  }
  if (!text && keys.length === 0) throw new Error('参数 text 与 keys 至少需要提供一个')

  for (const key of keys) {
    const seq = KEY_SEQUENCES[key]
    if (seq === undefined) {
      throw new Error(`未知按键：${key}，可用按键：${INTERACTIVE_KEY_NAMES.join(', ')}`)
    }
  }

  const payload = `${text}${keys.map(k => KEY_SEQUENCES[k]).join('')}`
  try {
    entry.channel.write(payload)
  } catch (e) {
    throw new Error(`写入交互式会话失败：${e instanceof Error ? e.message : String(e)}`)
  }

  const rawWait = Number(waitMs)
  const wait = Number.isFinite(rawWait) ? Math.max(0, Math.min(10000, rawWait)) : 800
  await collect(entry, wait, true)
  return buildResult(entry, 'delta')
}

/** 读取输出：delta 为自上次读取以来的增量，screen 为当前屏幕快照 */
export async function readInteractive(
  id: string,
  waitMs = 0,
  mode: InteractiveMode = 'delta',
): Promise<InteractiveReadResult> {
  const entry = requireEntry(id)
  const rawWait = Number(waitMs)
  const wait = Number.isFinite(rawWait) ? Math.max(0, Math.min(15000, rawWait)) : 0
  await collect(entry, wait, true)
  return buildResult(entry, mode)
}

/** 关闭交互式会话，返回关闭前的最终输出 */
export async function closeInteractive(id: string): Promise<InteractiveReadResult> {
  const entry = requireEntry(id)
  const result = buildResult(entry, 'delta')
  destroy(entry)
  await delay(150)
  return { ...result, running: false, exitCode: entry.exitCode }
}

/** 关闭某个 SSH 会话下的全部交互式会话（SSH 断开时兜底清理） */
export function closeInteractiveBySsh(sshSessionId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.sshSessionId === sshSessionId) destroy(entry)
  }
}

/** 关闭全部交互式会话（应用退出时调用） */
export function closeAllInteractive(): void {
  for (const entry of [...entries.values()]) destroy(entry)
}

// SSH 会话断开/异常时回收对应交互式会话
onSessionClosed(id => closeInteractiveBySsh(id))
