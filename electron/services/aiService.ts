import { randomUUID } from 'node:crypto'
import type { Readable as NodeReadable } from 'node:stream'
import { net, type IncomingMessage, type WebContents } from 'electron'
import type { AiErrorCode, AiSettings, AiTestResult, ChatMessage } from '../shared/types'

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

/** 无任何增量的最长时间（毫秒），超时中止 */
const NO_DATA_TIMEOUT = 120_000
/** 连通性测试超时（毫秒） */
const TEST_TIMEOUT = 30_000

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
}

function clearWatchdog(reqId: string) {
  const wd = watchdogs.get(reqId)
  if (wd) clearTimeout(wd)
  watchdogs.delete(reqId)
}

/**
 * 发起 OpenAI 兼容的流式对话。
 * 增量通过 webContents 事件推送：
 *   ai:delta (reqId, text) / ai:done (reqId) / ai:error (reqId, message)
 * 主动 abort 导致的结束也发 ai:done，渲染端按 reqId 幂等收尾。
 */
export async function streamChat(
  wc: WebContents,
  reqId: string,
  messages: ChatMessage[],
  ai: AiSettings,
): Promise<void> {
  const controller = new AbortController()
  controllers.set(reqId, controller)

  const send = (channel: 'ai:delta' | 'ai:done' | 'ai:error', payload?: string) => {
    if (!wc.isDestroyed()) wc.send(channel, reqId, payload)
  }

  const armWatchdog = () => {
    clearWatchdog(reqId)
    const wd = setTimeout(() => controller.abort(), NO_DATA_TIMEOUT)
    watchdogs.set(reqId, wd)
  }

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
        body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 }),
      },
      controller.signal,
    )

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      const text = await readBody(resp.body).catch(() => '')
      throw new Error(buildErrorDetail(resp.statusCode, resp.statusText, text))
    }

    armWatchdog()
    const decoder = new TextDecoder()
    let buffer = ''

    // IncomingMessage 为 Node Readable；abort 时 destroy，循环正常结束（按 done 收尾）
    for await (const chunk of resp.body) {
      armWatchdog()
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
            choices?: { delta?: { content?: string } }[]
          }
          const delta = json.choices?.[0]?.delta?.content
          if (delta) send('ai:delta', delta)
        } catch {
          // 忽略心跳 / 注释行 / 非 JSON 分片
        }
      }
    }

    // 读取中途网络错误会以流 error 抛出进入 catch；看门狗/主动中止 destroy 流后循环正常结束
    send('ai:done')
  } catch (e) {
    // 用户主动中止 / 看门狗超时中止：按正常结束处理（保留已生成内容）
    if (controller.signal.aborted) {
      send('ai:done')
    } else {
      send('ai:error', e instanceof Error ? e.message : String(e))
    }
  } finally {
    clearWatchdog(reqId)
    controllers.delete(reqId)
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
