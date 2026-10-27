import { randomUUID } from 'node:crypto'
import type { Readable as NodeReadable } from 'node:stream'
import { net, type IncomingMessage, type WebContents } from 'electron'
import type {
  AiErrorCode,
  AiSettings,
  AiStartPayload,
  AiTestResult,
  AiToolCall,
  ChatMessage,
  ChatToolCall,
  Language,
} from '../shared/types'
import { getSession } from './sshService'
import { McpClient, McpServer, toolNeedsApproval, type McpToolInfo } from './mcpService'

/**
 * Electron 类型声明里 IncomingMessage 只继承 EventEmitter，
 * 但运行时它实现了 Node Readable 流接口（destroy / asyncIterator / data 事件等）。
 */
type ResponseStream = IncomingMessage & NodeReadable

function asStream(resp: IncomingMessage): ResponseStream {
  return resp as unknown as ResponseStream
}

/** 进行中的请求：reqId → 中止控制器 / 无数据看门狗 */
const controllers = new Map<string, AbortController>()
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>()

/** 待用户确认的工具调用：key(reqId, toolCallId) → 决议函数 */
const approvals = new Map<string, (approved: boolean) => void>()

/** 无任何增量的最长时间（毫秒），超时中止 */
const NO_DATA_TIMEOUT = 120_000
/** 连通性测试超时（毫秒） */
const TEST_TIMEOUT = 30_000
/** 代理模式单次对话最多工具调用轮次 */
const MAX_AGENT_ROUNDS = 8

const approvalKey = (reqId: string, toolCallId: string) => `${reqId}\u0000${toolCallId}`

/** 校验并规范化 AI 配置，缺字段直接抛错 */
function normalizeAi(ai: AiSettings) {
  const key = ai.apiKey.trim()
  const base = ai.baseUrl.trim().replace(/\/+$/, '')
  const model = ai.model.trim()
  if (!key) throw new Error('Missing API key')
  if (!base) throw new Error('Missing API base URL')
  if (!model) throw new Error('Missing model name')
  return { key, base, model }
}

/** 从非 2xx 响应原文中提取可读错误信息（优先 error.message，其次 HTTP 状态 + 原文片段） */
function buildErrorDetail(status: number, statusText: string, text: string): string {
  let detail = `HTTP ${status} ${statusText}`.trim()
  try {
    const j = JSON.parse(text) as { error?: { message?: string } }
    if (j.error?.message) detail = j.error.message
  } catch {
    if (text) detail = `${detail}: ${text.slice(0, 300)}`
  }
  return detail
}

/**
 * 使用 Chromium 网络栈发请求（Electron net），自动遵循系统代理设置——
 * 这是 Node 自带 fetch/undici 不具备的行为：后者直连海外 API 会在需要代理的网络中超时。
 * - 连接阶段失败 / signal 中止以 reject 抛出
 * - 响应返回后 signal abort 会销毁响应流（for-await 正常结束，由上层按语义收尾）
 */
function httpRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  signal: AbortSignal,
): Promise<{ statusCode: number; statusText: string; body: ResponseStream }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: init.method, redirect: 'follow' })
    for (const [k, v] of Object.entries(init.headers)) req.setHeader(k, v)

    let settled = false

    const abortReq = () => {
      try {
        req.abort()
      } catch {
        /* noop */
      }
    }
    signal.addEventListener('abort', abortReq, { once: true })

    req.once('response', resp => {
      const stream = asStream(resp)
      if (signal.aborted) {
        stream.destroy()
        return
      }
      settled = true
      signal.removeEventListener('abort', abortReq)
      signal.addEventListener('abort', () => stream.destroy(), { once: true })
      resolve({ statusCode: resp.statusCode, statusText: resp.statusMessage, body: stream })
    })

    // 连接阶段错误（DNS / 代理 / 超时 / 重置等）
    req.once('error', err => {
      signal.removeEventListener('abort', abortReq)
      if (!settled) reject(classifyNetError(err, signal))
    })

    // 显式 abort（含 signal 触发）：归类为 abort/timeout，由上层判断
    req.once('abort', () => {
      signal.removeEventListener('abort', abortReq)
      if (!settled) reject(classifyNetError(new Error('net::ERR_ABORTED'), signal))
    })

    if (init.body) req.write(init.body)
    req.end()
  })
}

/** 读取响应体全文（UTF-8） */
async function readBody(resp: ResponseStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of resp) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** 带类别标签的网络错误 */
class AiNetError extends Error {
  code: AiErrorCode
  constructor(code: AiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 把 Chromium net 错误（net::ERR_*）归类，signal 中止优先判为 timeout/abort */
function classifyNetError(err: unknown, signal: AbortSignal): AiNetError {
  if (signal.aborted) return new AiNetError('timeout', 'aborted by signal')
  const raw = err instanceof Error ? err.message : String(err)
  if (/ERR_PROXY/i.test(raw)) return new AiNetError('proxy', raw)
  if (/TIMED_OUT|TIMEOUT/i.test(raw)) return new AiNetError('timeout', raw)
  if (/NAME_NOT_RESOLVED/i.test(raw)) return new AiNetError('dns', raw)
  if (/INTERNET_DISCONNECTED|CONNECTION_(REFUSED|RESET|CLOSED|FAILED)|ERR_NETWORK_CHANGED/i.test(raw))
    return new AiNetError('network', raw)
  return new AiNetError('network', raw)
}

/** 主动中止一次对话 */
export function abortChat(reqId: string) {
  controllers.get(reqId)?.abort()
  // 中止时把仍在等待用户确认的工具调用一律按拒绝处理，避免请求悬挂
  for (const [k, resolve] of approvals) {
    if (k.startsWith(`${reqId}\u0000`)) resolve(false)
  }
}

/** 用户对某个工具调用做出允许/拒绝决定 */
export function replyToolCall(reqId: string, toolCallId: string, approved: boolean) {
  approvals.get(approvalKey(reqId, toolCallId))?.(approved)
}

function clearWatchdog(reqId: string) {
  const wd = watchdogs.get(reqId)
  if (wd) clearTimeout(wd)
  watchdogs.delete(reqId)
}

/** 等待用户确认，signal 中止时按拒绝处理 */
function waitForApproval(
  reqId: string,
  toolCallId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise(resolve => {
    const key = approvalKey(reqId, toolCallId)
    let settled = false
    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      approvals.delete(key)
      signal.removeEventListener('abort', onAbort)
      resolve(approved)
    }
    const onAbort = () => finish(false)
    approvals.set(key, finish)
    if (signal.aborted) {
      finish(false)
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** OpenAI 兼容的工具声明 */
interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

interface RoundResult {
  /** 本轮助手文本 */
  content: string
  /** 本轮请求调用的工具 */
  toolCalls: ChatToolCall[]
}

interface RoundOptions {
  base: string
  key: string
  model: string
  messages: ChatMessage[]
  tools?: OpenAiTool[]
  signal: AbortSignal
  onDelta: (text: string) => void
  onActivity: () => void
}

/** 发起一轮流式请求，返回文本与工具调用（SSE 增量实时回调） */
async function streamRound(opts: RoundOptions): Promise<RoundResult> {
  const resp = await httpRequest(
    `${opts.base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.key}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: 0.7,
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
      }),
    },
    opts.signal,
  )

  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    const text = await readBody(resp.body).catch(() => '')
    throw new Error(buildErrorDetail(resp.statusCode, resp.statusText, text))
  }

  opts.onActivity()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  /** 按 index 累积流式 tool_calls 分片 */
  const acc = new Map<number, { id: string; name: string; args: string }>()

  // IncomingMessage 为 Node Readable；abort 时 destroy，循环正常结束（按 done 收尾）
  for await (const chunk of resp.body) {
    opts.onActivity()
    buffer += decoder.decode(chunk, { stream: true })

    // SSE 以空行分隔事件；按行解析 data: 前缀，最后一段可能不完整，留到下次
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const json = JSON.parse(data) as {
          choices?: {
            delta?: {
              content?: string
              tool_calls?: {
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }[]
            }
          }[]
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.content) {
          content += delta.content
          opts.onDelta(delta.content)
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const cur = acc.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          acc.set(idx, cur)
        }
      } catch {
        // 忽略心跳 / 注释行 / 非 JSON 分片
      }
    }
  }

  const toolCalls: ChatToolCall[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name)
    .map(([, c]) => ({
      id: c.id || `call_${randomUUID()}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args || '{}' },
    }))

  return { content, toolCalls }
}

/** 代理模式系统提示词（按界面语言生成） */
function agentInstructions(payloadCtx: NonNullable<AiStartPayload['context']>, lang: Language): string {
  const target = `${payloadCtx.username}@${payloadCtx.host}${
    payloadCtx.connectionName ? `（${payloadCtx.connectionName}）` : ''
  }`
  if (lang === 'en-US') {
    return [
      'You are in Agent Mode and can operate the server of the current SSH session directly.',
      `Current session: ${target}.`,
      'You have MCP tools: run_command, read_file, list_directory, write_file.',
      'Rules:',
      '1. Call tools when you need server information or need to perform a task; never fabricate results.',
      '2. run_command and write_file require explicit user approval before execution. Call one tool at a time and wait for its result before deciding the next step.',
      '3. Prefer read-only commands. Do not run destructive commands (rm -rf /, mkfs, dd, shutdown, etc.) unless the user explicitly asks and you have explained the risk.',
      '4. Commands must be non-interactive (use -y/--no-pager where needed); avoid full-screen programs such as vim/top and avoid long-blocking commands.',
      '5. When finished, summarize concisely in the user language; do not paste large raw outputs.',
    ].join('\n')
  }
  return [
    '你现在处于代理模式，可以直接操作当前 SSH 会话所在的服务器。',
    `当前会话：${target}。`,
    '你可以使用 MCP 工具：run_command、read_file、list_directory、write_file。',
    '规则：',
    '1. 需要服务器信息或要执行任务时调用工具，不要臆造结果。',
    '2. run_command 与 write_file 需要用户确认后才会真正执行；一次只调用一个工具，等待结果后再决定下一步。',
    '3. 优先使用只读命令；严禁执行 rm -rf /、mkfs、dd、shutdown 等破坏性操作，除非用户明确要求并已说明风险。',
    '4. 命令必须是非交互式的（必要时加 -y/--no-pager），避免 vim/top 等全屏程序，避免长时间阻塞。',
    '5. 完成后用与用户相同的语言简洁总结，不要整段粘贴原始输出。',
  ].join('\n')
}

/** 把代理模式指令并入系统提示词 */
function buildAgentMessages(
  messages: ChatMessage[],
  ctx: NonNullable<AiStartPayload['context']>,
  lang: Language,
): ChatMessage[] {
  const instructions = agentInstructions(ctx, lang)
  const copy = [...messages]
  const idx = copy.findIndex(m => m.role === 'system')
  if (idx >= 0) {
    const cur = copy[idx].content ?? ''
    copy[idx] = { role: 'system', content: cur ? `${cur}\n\n${instructions}` : instructions }
  } else {
    copy.unshift({ role: 'system', content: instructions })
  }
  return copy
}

/** MCP 工具定义转换为 OpenAI tools 声明 */
function toOpenAiTools(tools: McpToolInfo[]): OpenAiTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

/** 解析模型给出的工具参数 JSON */
function parseToolArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  if (!raw.trim()) return { args: {} }
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { args: v as Record<string, unknown> }
    }
    return { args: {}, error: '工具参数必须是 JSON 对象' }
  } catch (e) {
    return {
      args: {},
      error: `工具参数解析失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

interface ChatRuntime {
  reqId: string
  wc: WebContents
  controller: AbortController
  base: string
  key: string
  model: string
  language: Language
  sendDelta: (text: string) => void
  sendDone: () => void
  sendTool: (call: AiToolCall) => void
  sendToolResult: (toolCallId: string, status: AiToolCall['status'], output: string) => void
  armWatchdog: () => void
}

/** 对话模式：单轮流式回答 */
async function runChat(rt: ChatRuntime, payload: AiStartPayload): Promise<void> {
  await streamRound({
    base: rt.base,
    key: rt.key,
    model: rt.model,
    messages: payload.messages,
    signal: rt.controller.signal,
    onDelta: rt.sendDelta,
    onActivity: rt.armWatchdog,
  })
  clearWatchdog(rt.reqId)
  rt.sendDone()
}

/** 代理模式：流式回答 + MCP 工具调用循环（写操作等待用户确认） */
async function runAgent(rt: ChatRuntime, payload: AiStartPayload): Promise<void> {
  const ctx = payload.context
  const noSession =
    rt.language === 'zh-CN'
      ? '当前终端未连接到服务器，无法使用代理模式。请先建立 SSH 连接。'
      : 'No active SSH session. Connect to a server before using agent mode.'
  if (!ctx || !getSession(ctx.sessionId)) throw new Error(noSession)

  // 每个请求独立创建 MCP 服务与客户端（工具绑定当前会话）
  const client = new McpClient(new McpServer({ sessionId: ctx.sessionId }))
  await client.initialize()
  const tools = toOpenAiTools(await client.listTools())

  const messages = buildAgentMessages(payload.messages, ctx, rt.language)

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (rt.controller.signal.aborted) {
      rt.sendDone()
      return
    }

    const result = await streamRound({
      base: rt.base,
      key: rt.key,
      model: rt.model,
      messages,
      tools,
      signal: rt.controller.signal,
      onDelta: rt.sendDelta,
      onActivity: rt.armWatchdog,
    })
    // 一轮结束即清理看门狗：等待用户确认期间不应触发无数据超时
    clearWatchdog(rt.reqId)

    if (rt.controller.signal.aborted) {
      rt.sendDone()
      return
    }
    if (result.toolCalls.length === 0) {
      rt.sendDone()
      return
    }

    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls,
    })

    for (const call of result.toolCalls) {
      if (rt.controller.signal.aborted) {
        rt.sendDone()
        return
      }

      const name = call.function.name
      const parsed = parseToolArgs(call.function.arguments)
      const needsApproval = toolNeedsApproval(name)
      const toolCall: AiToolCall = {
        id: call.id,
        name,
        args: parsed.args,
        needsApproval,
        status: needsApproval ? 'pending' : 'running',
      }
      rt.sendTool(toolCall)

      if (needsApproval) {
        const approved = await waitForApproval(rt.reqId, call.id, rt.controller.signal)
        if (!approved) {
          const denied =
            rt.language === 'zh-CN' ? '用户拒绝执行该操作。' : 'The user denied this operation.'
          rt.sendToolResult(call.id, 'denied', denied)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'The user denied this operation.',
          })
          continue
        }
        rt.sendTool({ ...toolCall, status: 'running' })
      }

      if (parsed.error) {
        rt.sendToolResult(call.id, 'error', parsed.error)
        messages.push({ role: 'tool', tool_call_id: call.id, content: parsed.error })
        continue
      }

      try {
        const r = await client.callTool(name, parsed.args)
        rt.sendToolResult(call.id, r.isError ? 'error' : 'done', r.text)
        messages.push({ role: 'tool', tool_call_id: call.id, content: r.text })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        rt.sendToolResult(call.id, 'error', msg)
        messages.push({ role: 'tool', tool_call_id: call.id, content: msg })
      }

      if (rt.controller.signal.aborted) {
        rt.sendDone()
        return
      }
    }
  }

  // 达到轮次上限：保留已生成内容并提示用户可继续对话
  rt.sendDelta(
    rt.language === 'zh-CN'
      ? '\n\n（已达到单次对话的最大工具调用轮次，可继续提问以处理剩余任务）'
      : '\n\n(Reached the maximum tool-call rounds for one message. Send another message to continue.)',
  )
  rt.sendDone()
}

/**
 * 发起 OpenAI 兼容的流式对话。
 * 增量通过 webContents 事件推送：
 *   ai:delta (reqId, text) / ai:done (reqId) / ai:error (reqId, message)
 * 代理模式额外推送：
 *   ai:tool (reqId, AiToolCall) / ai:toolResult (reqId, toolCallId, status, output)
 * 主动 abort 导致的结束也发 ai:done，渲染端按 reqId 幂等收尾。
 */
export async function streamChat(
  wc: WebContents,
  reqId: string,
  payload: AiStartPayload,
  ai: AiSettings,
  language: Language,
): Promise<void> {
  const controller = new AbortController()
  controllers.set(reqId, controller)

  const send = (channel: 'ai:delta' | 'ai:done' | 'ai:error', data?: string) => {
    if (!wc.isDestroyed()) wc.send(channel, reqId, data)
  }

  const armWatchdog = () => {
    clearWatchdog(reqId)
    const wd = setTimeout(() => controller.abort(), NO_DATA_TIMEOUT)
    watchdogs.set(reqId, wd)
  }

  try {
    const { key, base, model } = normalizeAi(ai)
    const rt: ChatRuntime = {
      reqId,
      wc,
      controller,
      base,
      key,
      model,
      language,
      sendDelta: text => send('ai:delta', text),
      sendDone: () => send('ai:done'),
      sendTool: call => {
        if (!wc.isDestroyed()) wc.send('ai:tool', reqId, call)
      },
      sendToolResult: (toolCallId, status, output) => {
        if (!wc.isDestroyed()) wc.send('ai:toolResult', reqId, toolCallId, status, output)
      },
      armWatchdog,
    }

    if (payload.mode === 'agent') await runAgent(rt, payload)
    else await runChat(rt, payload)
  } catch (e) {
    clearWatchdog(reqId)
    // 用户主动中止 / 看门狗超时中止：按正常结束处理（保留已生成内容）
    if (controller.signal.aborted) {
      send('ai:done')
    } else {
      send('ai:error', e instanceof Error ? e.message : String(e))
    }
  } finally {
    clearWatchdog(reqId)
    controllers.delete(reqId)
    // 兜底清理本请求遗留的审批等待
    for (const [k, resolve] of approvals) {
      if (k.startsWith(`${reqId}\u0000`)) resolve(false)
    }
  }
}

/**
 * 连通性测试：发一条非流式最小请求，验证 Key / BaseURL / 模型是否可用。
 * 判定标准：HTTP 200 且响应包含 choices 即视为连通（鉴权与模型名有效）；
 * content 可能为 null/空（推理模型 token 耗尽于思考过程、内容审核等），不作为失败依据。
 * 任何异常都归一为 { ok:false, code, error }，不抛出。
 */
export async function testChat(ai: AiSettings): Promise<AiTestResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT)
  try {
    const { key, base, model } = normalizeAi(ai)

    const resp = await httpRequest(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 64,
          stream: false,
        }),
      },
      controller.signal,
    )

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      const text = await readBody(resp.body).catch(() => '')
      return {
        ok: false,
        code: 'http',
        error: buildErrorDetail(resp.statusCode, resp.statusText, text),
      }
    }

    const raw = await readBody(resp.body)
    if (controller.signal.aborted) {
      return { ok: false, code: 'timeout', error: `Request timeout after ${TEST_TIMEOUT / 1000}s` }
    }

    let json: {
      choices?: {
        message?: { content?: string | null; reasoning_content?: string | null }
      }[]
    }
    try {
      json = JSON.parse(raw)
    } catch {
      return { ok: false, code: 'parse', error: `Non-JSON response: ${raw.slice(0, 300)}` }
    }

    const choice = json.choices?.[0]
    if (!choice) {
      return { ok: false, code: 'parse', error: `No choices in response: ${raw.slice(0, 300)}` }
    }
    // 兼容推理模型：正文为空时回退取思考内容片段作为展示
    const reply =
      choice.message?.content?.trim() || choice.message?.reasoning_content?.trim() || ''
    return { ok: true, reply: reply.slice(0, 100) }
  } catch (e) {
    if (e instanceof AiNetError) {
      if (e.code === 'timeout' || controller.signal.aborted) {
        return {
          ok: false,
          code: 'timeout',
          error: `Request timeout after ${TEST_TIMEOUT / 1000}s`,
        }
      }
      return { ok: false, code: e.code, error: e.message }
    }
    return { ok: false, code: 'network', error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 生成请求 ID */
export function newChatReqId(): string {
  return randomUUID()
}
