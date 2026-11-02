import { execCommand } from './sshService'
import { list, readFile, writeFile } from './sftpService'
import {
  INTERACTIVE_KEY_NAMES,
  closeInteractive,
  readInteractive,
  sendInteractive,
  startInteractive,
  type InteractiveMode,
  type InteractiveReadResult,
} from './interactiveService'

/**
 * 轻量 MCP（Model Context Protocol）服务：
 * - 以 JSON-RPC 2.0 语义实现 initialize / tools/list / tools/call
 * - 工具绑定当前 SSH 会话（代理模式只操作用户当前所在的服务器）
 * - 需要写操作的工具标记 needsApproval，由 AI 服务在调用前向用户确认
 */

/** MCP 协议版本（与主流 MCP 客户端兼容的稳定版本） */
const PROTOCOL_VERSION = '2024-11-05'

/** 工具输出最大长度（字符），避免撑爆模型上下文 */
const MAX_OUTPUT = 20_000
/** write_file 内容最大长度（字符） */
const MAX_WRITE = 1024 * 1024
/** list_directory 最多返回条目数 */
const MAX_ENTRIES = 500

export interface McpJsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** 工具定义（needsApproval 为本应用扩展，不进入 MCP tools/list 响应） */
export interface McpTool {
  name: string
  description: string
  inputSchema: McpJsonSchema
  needsApproval: boolean
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'run_command',
    description:
      '在远程服务器上执行一条非交互式 shell 命令，返回退出码、stdout 和 stderr。' +
      '执行前会展示给用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: {
          type: 'number',
          description: '超时时间（秒），默认 60，最大 300',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    needsApproval: true,
  },
  {
    name: 'read_file',
    description: '读取远程服务器上的文本文件内容（超大或二进制文件会失败）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '远程文件绝对路径或相对当前目录的路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needsApproval: false,
  },
  {
    name: 'list_directory',
    description: '列出远程服务器上某个目录的文件与子目录。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认当前目录 "."' },
      },
      additionalProperties: false,
    },
    needsApproval: false,
  },
  {
    name: 'write_file',
    description:
      '将文本内容写入远程服务器上的文件（覆盖已有内容，不存在则创建）。' +
      '执行前会展示给用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '远程文件路径' },
        content: { type: 'string', description: '要写入的完整文本内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    needsApproval: true,
  },
  {
    name: 'start_interactive_session',
    description:
      '在远程服务器上启动一条需要持续输入的命令（如 sudo 密码提示、apt 确认、read -p、mysql/redis REPL、top/vim 等全屏程序），' +
      '返回 sessionId 与初始输出。后续用 send_interactive_input 输入、read_interactive_output 读取，用完调用 close_interactive_session。' +
      '会话在本轮 AI 对话结束后自动关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        term: { type: 'string', description: '终端类型，默认 xterm-256color' },
        cols: { type: 'number', description: '终端列数（20-300），默认 120' },
        rows: { type: 'number', description: '终端行数（5-100），默认 40' },
        waitMs: {
          type: 'number',
          description: '启动后等待初始输出的最长时间（毫秒，0-15000），默认 800',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    needsApproval: true,
  },
  {
    name: 'send_interactive_input',
    description:
      '向已启动的交互式会话写入文本或按键（如回车、Ctrl+C、方向键），返回自上次读取以来的新增输出。' +
      '每次输入都会单独展示给用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'start_interactive_session 返回的会话 id' },
        text: { type: 'string', description: '按原样写入的文本（可为空）' },
        keys: {
          type: 'array',
          items: { type: 'string', enum: INTERACTIVE_KEY_NAMES },
          description: '要发送的按键（可多选），与 text 按顺序拼接后写入',
        },
        waitMs: {
          type: 'number',
          description: '写入后等待输出的最长时间（毫秒，0-10000），默认 800',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    needsApproval: true,
  },
  {
    name: 'read_interactive_output',
    description:
      '读取交互式会话的输出。mode=delta（默认）返回自上次读取以来的新增文本；' +
      'mode=screen 返回当前屏幕的纯文本快照，适合 top / vim 等全屏程序。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '交互式会话 id' },
        mode: {
          type: 'string',
          enum: ['delta', 'screen'],
          description: 'delta=新增输出；screen=当前屏幕快照',
        },
        waitMs: {
          type: 'number',
          description: '读取前等待新输出的最长时间（毫秒，0-15000），默认 0',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    needsApproval: false,
  },
  {
    name: 'close_interactive_session',
    description: '关闭交互式会话（先发送 Ctrl+C，再终止通道），返回关闭前的最终输出。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要关闭的交互式会话 id' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    needsApproval: true,
  },
]

export interface McpServerContext {
  sessionId: string
}

type JsonRpcId = number | string

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: { code: number; message: string }
}

/** 截断过长输出并附加提示 */
function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（输出过长，已截断，共 ${text.length} 字符）`
}

/** 带超时的 Promise 执行（超时后底层命令仍会继续，但不再等待） */
function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    task.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

/** 交互式会话状态描述 */
function interactiveStatus(r: InteractiveReadResult): string {
  return r.running ? '运行中' : `已结束（退出码 ${r.exitCode ?? '未知'}）`
}

/** 交互式会话输出文本（delta / screen 通用） */
function formatInteractiveOutput(r: InteractiveReadResult): string {
  if (r.mode === 'screen') {
    return `会话 ${r.id}（${interactiveStatus(r)}）\n屏幕快照:\n${r.output.trim() || '（空屏幕）'}`
  }
  const parts = [
    `会话 ${r.id}（${interactiveStatus(r)}）`,
    `新增输出:\n${r.output.trim() || '（无新增输出）'}`,
  ]
  if (r.truncated) parts.push('（输出过长，仅保留最近部分）')
  return parts.join('\n')
}

/** 执行工具，返回给模型的文本与是否为错误 */
async function executeTool(
  ctx: McpServerContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; sessionId?: string }> {
  if (name === 'run_command') {
    const command = strArg(args, 'command').trim()
    const seconds = Math.max(1, Math.min(300, Number(args.timeout) || 60))
    const res = await withTimeout(
      execCommand(ctx.sessionId, command),
      seconds * 1000,
      `命令执行超时（${seconds}s）`,
    )
    const parts = [`退出码: ${res.code}`]
    if (res.stdout.trim()) parts.push(`stdout:\n${res.stdout.trimEnd()}`)
    if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trimEnd()}`)
    if (!res.stdout.trim() && !res.stderr.trim()) parts.push('（无输出）')
    return { text: truncate(parts.join('\n\n')), isError: res.code !== 0 }
  }

  if (name === 'read_file') {
    const path = strArg(args, 'path')
    const content = await readFile(ctx.sessionId, path)
    return { text: truncate(content), isError: false }
  }

  if (name === 'list_directory') {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
    const entries = await list(ctx.sessionId, path)
    const shown = entries.slice(0, MAX_ENTRIES)
    const lines = shown.map(e => {
      const kind = e.isDir ? 'd' : e.symlink ? 'l' : '-'
      return `${kind} ${String(e.size).padStart(10)}  ${e.name}`
    })
    if (entries.length > shown.length) {
      lines.push(`…（共 ${entries.length} 项，仅显示前 ${shown.length} 项）`)
    }
    return {
      text: truncate(`目录 ${path}（${entries.length} 项）:\n${lines.join('\n')}`),
      isError: false,
    }
  }

  if (name === 'write_file') {
    const path = strArg(args, 'path')
    const content = typeof args.content === 'string' ? args.content : ''
    if (content.length > MAX_WRITE) {
      throw new Error(`写入内容过长（${content.length} 字符），超过上限 ${MAX_WRITE} 字符`)
    }
    await writeFile(ctx.sessionId, path, content)
    return {
      text: `已写入 ${Buffer.byteLength(content, 'utf8')} 字节到 ${path}`,
      isError: false,
    }
  }

  if (name === 'start_interactive_session') {
    const command = strArg(args, 'command').trim()
    const r = await startInteractive(ctx.sessionId, command, {
      term: typeof args.term === 'string' ? args.term : undefined,
      cols: typeof args.cols === 'number' ? args.cols : undefined,
      rows: typeof args.rows === 'number' ? args.rows : undefined,
      waitMs: typeof args.waitMs === 'number' ? args.waitMs : 800,
    })
    const parts = [
      '会话已启动',
      `sessionId: ${r.id}`,
      `命令: ${command}`,
      `状态: ${interactiveStatus(r)}`,
      `初始输出:\n${r.output.trim() || '（暂无输出）'}`,
    ]
    if (r.truncated) parts.push('（输出过长，仅保留最近部分）')
    return { text: truncate(parts.join('\n')), isError: false, sessionId: r.id }
  }

  if (name === 'send_interactive_input') {
    const sessionId = strArg(args, 'sessionId')
    const text = typeof args.text === 'string' ? args.text : ''
    const keys = Array.isArray(args.keys)
      ? args.keys.filter((k): k is string => typeof k === 'string')
      : []
    if (!text && keys.length === 0) throw new Error('参数 text 与 keys 至少需要提供一个')
    const waitMs = typeof args.waitMs === 'number' ? args.waitMs : 800
    const r = await sendInteractive(sessionId, text, keys, waitMs)
    return { text: truncate(formatInteractiveOutput(r)), isError: false }
  }

  if (name === 'read_interactive_output') {
    const sessionId = strArg(args, 'sessionId')
    const mode: InteractiveMode = args.mode === 'screen' ? 'screen' : 'delta'
    const waitMs = typeof args.waitMs === 'number' ? args.waitMs : 0
    const r = await readInteractive(sessionId, waitMs, mode)
    return { text: truncate(formatInteractiveOutput(r)), isError: false }
  }

  if (name === 'close_interactive_session') {
    const sessionId = strArg(args, 'sessionId')
    const r = await closeInteractive(sessionId)
    const parts = [
      `会话 ${r.id} 已关闭`,
      `退出码: ${r.exitCode ?? '未知'}`,
      `最终输出:\n${r.output.trim() || '（无输出）'}`,
    ]
    return { text: truncate(parts.join('\n')), isError: false }
  }

  throw new Error(`未知工具：${name}`)
}

/** MCP 服务端：处理 JSON-RPC 请求（同一进程内由 McpClient 调用） */
export class McpServer {
  /** 本实例创建的交互式会话 id，请求结束时统一关闭 */
  private readonly interactiveIds = new Set<string>()

  constructor(private readonly ctx: McpServerContext) {}

  /** 关闭本实例创建的交互式会话（AI 请求结束 / 中止时调用） */
  async dispose(): Promise<void> {
    const ids = [...this.interactiveIds]
    this.interactiveIds.clear()
    await Promise.allSettled(ids.map(id => closeInteractive(id).catch(() => undefined)))
  }

  /** 处理一条 JSON-RPC 消息；通知（无 id）返回 null */
  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null

    try {
      if (req.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'mssh-mcp', version: '1.0.0' },
          },
        }
      }

      if (req.method === 'notifications/initialized') return null

      if (req.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        }
      }

      if (req.method === 'tools/call') {
        const params = req.params ?? {}
        const name = typeof params.name === 'string' ? params.name : ''
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {}
        try {
          const r = await executeTool(this.ctx, name, args)
          if (r.sessionId) this.interactiveIds.add(r.sessionId)
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: r.text }], isError: r.isError },
          }
        } catch (e) {
          // 工具执行失败按 MCP 约定放在 result.isError，而不是协议级 error
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                { type: 'text', text: e instanceof Error ? e.message : String(e) },
              ],
              isError: true,
            },
          }
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      }
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      }
    }
  }
}

/** MCP 工具列表响应中的条目 */
export interface McpToolInfo {
  name: string
  description: string
  inputSchema: McpJsonSchema
}

/** MCP 客户端：按协议完成握手、列工具、调用工具 */
export class McpClient {
  private nextId = 1

  constructor(private readonly server: McpServer) {}

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.server.handle({
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    })
    if (!res) throw new Error(`MCP 通知未返回响应：${method}`)
    if (res.error) throw new Error(res.error.message)
    return res.result as T
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mssh-ai', version: '1.0.0' },
    })
    await this.server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async listTools(): Promise<McpToolInfo[]> {
    const r = await this.request<{ tools: McpToolInfo[] }>('tools/list')
    return r.tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const r = await this.request<{
      content?: { type: string; text?: string }[]
      isError?: boolean
    }>('tools/call', { name, arguments: args })
    const text = (r.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n')
    return { text: text || '（无输出）', isError: Boolean(r.isError) }
  }
}

/** 按工具名查询是否需要用户确认（默认需要，未知工具按需确认处理） */
export function toolNeedsApproval(name: string): boolean {
  return MCP_TOOLS.find(t => t.name === name)?.needsApproval ?? true
}
