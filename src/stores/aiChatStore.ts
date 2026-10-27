import { create } from 'zustand'
import type {
  AiAgentContext,
  AiMode,
  AiToolCall,
  ChatMessage,
} from '../../electron/shared/types'
import { useAppStore } from './appStore'
import { getGlobalT } from '../i18n/I18nProvider'

/** 对话中的一条消息（区别于发送给接口的 ChatMessage，多了 UI 状态） */
export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 助手消息请求失败（content 为错误详情） */
  error?: boolean
  /** 助手消息正在流式生成 */
  generating?: boolean
  /** 代理模式下本轮消息触发的 MCP 工具调用 */
  tools?: AiToolCall[]
}

export interface AiChat {
  id: string
  /** 会话标题，空串表示尚未发出首条消息（UI 显示占位文案） */
  title: string
  createdAt: number
  messages: AiMessage[]
}

interface AiChatState {
  chats: AiChat[]
  activeChatId: string | null
  /** 创建会话并激活，返回新 id */
  newChat: () => string
  deleteChat: (id: string) => void
  setActive: (id: string) => void
  /** 发送一条提问（自动建会话、追加消息、发起流式请求） */
  send: (content: string, context?: AiAgentContext) => Promise<void>
  /** 停止当前会话正在生成的回复 */
  stop: () => void
  /** 基于最后一条提问重新生成回复 */
  retry: (context?: AiAgentContext) => void
  /** 代理模式：允许或拒绝某次工具调用 */
  replyTool: (chatId: string, msgId: string, toolCallId: string, approved: boolean) => void
}

/** 上下文最多携带的历史消息条数（控制系统提示词之外的 token 量） */
const MAX_HISTORY = 40
const LS_KEY = 'mssh.aiChats.v1'

/** 进行中的请求：reqId → 会话/消息定位 */
const pending = new Map<string, { chatId: string; msgId: string }>()

function load(): { chats: AiChat[]; activeChatId: string | null } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { chats: [], activeChatId: null }
    const parsed = JSON.parse(raw) as { chats?: AiChat[]; activeChatId?: string | null }
    return {
      // 重启后不可能仍在生成/等待审批，重置运行时状态
      chats: (parsed.chats ?? []).map(c => ({
        ...c,
        messages: (c.messages ?? []).map(m => ({
          ...m,
          generating: false,
          tools: m.tools?.map(t =>
            t.status === 'pending' || t.status === 'running'
              ? { ...t, status: 'error' as const, output: '' }
              : t,
          ),
        })),
      })),
      activeChatId: parsed.activeChatId ?? null,
    }
  } catch {
    return { chats: [], activeChatId: null }
  }
}

function updateChat(id: string, fn: (c: AiChat) => AiChat) {
  useAiChatStore.setState(s => ({
    chats: s.chats.map(c => (c.id === id ? fn(c) : c)),
  }))
}

function patchMessage(chatId: string, msgId: string, patch: Partial<AiMessage>) {
  updateChat(chatId, c => ({
    ...c,
    messages: c.messages.map(m => (m.id === msgId ? { ...m, ...patch } : m)),
  }))
}

/**
 * 组装发送给模型的消息：
 * - 对话模式：系统提示词 + 最近成功的历史（仅文本）
 * - 代理模式：额外携带工具调用与工具结果，让模型在多轮对话中保留执行上下文
 */
function buildMessages(history: AiMessage[], systemPrompt: string, mode: AiMode): ChatMessage[] {
  const recent = history
    .filter(m => !m.error && (m.content.trim() || m.tools?.length))
    .slice(-MAX_HISTORY)
  const out: ChatMessage[] = []
  const sys = systemPrompt.trim()
  if (sys) out.push({ role: 'system', content: sys })

  for (const m of recent) {
    if (m.role === 'user') {
      if (m.content.trim()) out.push({ role: 'user', content: m.content })
      continue
    }

    if (mode === 'chat') {
      if (m.content.trim()) out.push({ role: 'assistant', content: m.content })
      continue
    }

    // 只回传已有结论的工具调用（跳过等待审批/执行中的应用重启遗留状态）
    const completed = (m.tools ?? []).filter(
      t => t.status === 'done' || t.status === 'error' || t.status === 'denied',
    )
    if (completed.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: completed.map(t => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        })),
      })
      for (const t of completed) {
        out.push({ role: 'tool', tool_call_id: t.id, content: t.output ?? '' })
      }
    } else if (m.content.trim()) {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

function aiConfigured(): boolean {
  const ai = useAppStore.getState().settings.ai
  return Boolean(ai.apiKey.trim() && ai.baseUrl.trim() && ai.model.trim())
}

/** 发起主进程流式请求并登记 reqId */
async function launch(
  chatId: string,
  msgId: string,
  history: AiMessage[],
  context?: AiAgentContext,
) {
  const { systemPrompt, mode } = useAppStore.getState().settings.ai
  if (mode === 'agent' && !context) {
    patchMessage(chatId, msgId, {
      generating: false,
      error: true,
      content: getGlobalT()('ai.needSession'),
    })
    return
  }
  try {
    const reqId = await window.api.aiStart({
      messages: buildMessages(history, systemPrompt, mode),
      mode,
      context: mode === 'agent' ? context : undefined,
    })
    pending.set(reqId, { chatId, msgId })
  } catch (e) {
    patchMessage(chatId, msgId, {
      generating: false,
      error: true,
      content: e instanceof Error ? e.message : String(e),
    })
  }
}

/** 对话 store：会话列表持久化在 localStorage，流式事件经 initAiListener 驱动 */
export const useAiChatStore = create<AiChatState>((set, get) => ({
  ...load(),

  newChat: () => {
    const id = crypto.randomUUID()
    set(s => ({
      chats: [{ id, title: '', createdAt: Date.now(), messages: [] }, ...s.chats],
      activeChatId: id,
    }))
    return id
  },

  deleteChat: id => {
    set(s => {
      const chats = s.chats.filter(c => c.id !== id)
      return {
        chats,
        activeChatId: s.activeChatId === id ? (chats[0]?.id ?? null) : s.activeChatId,
      }
    })
  },

  setActive: id => set({ activeChatId: id }),

  send: async (content, context) => {
    const text = content.trim()
    if (!text) return
    let chatId = get().activeChatId
    if (!chatId) chatId = get().newChat()
    const chat = get().chats.find(c => c.id === chatId)
    if (!chat || chat.messages.some(m => m.generating) || !aiConfigured()) return

    const userMsg: AiMessage = { id: crypto.randomUUID(), role: 'user', content: text }
    const aiMsgId = crypto.randomUUID()
    const nextMessages = [
      ...chat.messages,
      userMsg,
      { id: aiMsgId, role: 'assistant' as const, content: '', generating: true },
    ]
    updateChat(chatId, c => ({
      ...c,
      title: c.messages.length === 0 ? text.slice(0, 30) : c.title,
      messages: nextMessages,
    }))
    await launch(chatId, aiMsgId, nextMessages, context)
  },

  stop: () => {
    const chat = get().chats.find(c => c.id === get().activeChatId)
    if (!chat) return
    for (const m of chat.messages) {
      if (!m.generating) continue
      for (const [reqId, v] of pending) {
        if (v.msgId === m.id) {
          window.api.aiAbort(reqId)
          pending.delete(reqId)
        }
      }
      patchMessage(chat.id, m.id, { generating: false })
    }
  },

  retry: context => {
    const chatId = get().activeChatId
    if (!chatId) return
    const chat = get().chats.find(c => c.id === chatId)
    if (!chat || chat.messages.some(m => m.generating)) return

    // 去掉末尾的助手消息（失败提示或上次回答），基于最后一条用户提问重新请求
    const msgs = [...chat.messages]
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop()
    const last = msgs[msgs.length - 1]
    if (!last || last.role !== 'user') return

    get().stop()
    const aiMsgId = crypto.randomUUID()
    const nextMessages = [
      ...msgs,
      { id: aiMsgId, role: 'assistant' as const, content: '', generating: true },
    ]
    updateChat(chatId, c => ({ ...c, messages: nextMessages }))
    void launch(chatId, aiMsgId, nextMessages, context)
  },

  replyTool: (chatId, msgId, toolCallId, approved) => {
    let reqId: string | null = null
    for (const [id, p] of pending) {
      if (p.chatId === chatId && p.msgId === msgId) {
        reqId = id
        break
      }
    }
    if (!reqId) return

    const chat = get().chats.find(c => c.id === chatId)
    const msg = chat?.messages.find(m => m.id === msgId)
    if (!msg) return

    window.api.aiToolReply(reqId, toolCallId, approved)
    patchMessage(chatId, msgId, {
      tools: msg.tools?.map(t =>
        t.id === toolCallId ? { ...t, status: approved ? 'running' : 'denied' } : t,
      ),
    })
  },
}))

// 持久化（generating 为运行时状态，不写入）
useAiChatStore.subscribe(s => {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        chats: s.chats.map(c => ({
          ...c,
          messages: c.messages.map(m => ({ ...m, generating: false })),
        })),
        activeChatId: s.activeChatId,
      }),
    )
  } catch {
    // localStorage 配额不足等情况忽略，不影响当次会话
  }
})

/** 订阅主进程 AI 流式事件（全局一次，App 启动时调用） */
let listenerInited = false
export function initAiListener() {
  if (listenerInited) return
  listenerInited = true

  window.api.onAiDelta((reqId, delta) => {
    const p = pending.get(reqId)
    if (!p) return
    useAiChatStore.setState(s => ({
      chats: s.chats.map(c =>
        c.id !== p.chatId
          ? c
          : {
              ...c,
              messages: c.messages.map(m =>
                m.id !== p.msgId ? m : { ...m, content: m.content + delta },
              ),
            },
      ),
    }))
  })

  // 工具调用请求：按 id 插入/更新到当前助手消息
  window.api.onAiTool((reqId, call) => {
    const p = pending.get(reqId)
    if (!p) return
    const chat = useAiChatStore.getState().chats.find(c => c.id === p.chatId)
    const msg = chat?.messages.find(m => m.id === p.msgId)
    if (!msg) return
    const prev = msg.tools ?? []
    const tools = prev.some(t => t.id === call.id)
      ? prev.map(t => (t.id === call.id ? { ...t, ...call } : t))
      : [...prev, call]
    patchMessage(p.chatId, p.msgId, { tools })
  })

  // 工具执行结果：更新对应卡片状态与输出
  window.api.onAiToolResult((reqId, toolCallId, status, output) => {
    const p = pending.get(reqId)
    if (!p) return
    const chat = useAiChatStore.getState().chats.find(c => c.id === p.chatId)
    const msg = chat?.messages.find(m => m.id === p.msgId)
    if (!msg) return
    patchMessage(p.chatId, p.msgId, {
      tools: msg.tools?.map(t => (t.id === toolCallId ? { ...t, status, output } : t)),
    })
  })

  const finish = (reqId: string, error?: string) => {
    const p = pending.get(reqId)
    if (!p) return
    pending.delete(reqId)
    const chat = useAiChatStore.getState().chats.find(c => c.id === p.chatId)
    const msg = chat?.messages.find(m => m.id === p.msgId)
    // 结束时仍未完成的工具调用（用户中止 / 连接中断）标记为失败
    const tools = msg?.tools?.map(t =>
      t.status === 'pending' || t.status === 'running'
        ? {
            ...t,
            status: (t.status === 'pending' ? 'denied' : 'error') as AiToolCall['status'],
            output: t.output ?? '',
          }
        : t,
    )
    patchMessage(
      p.chatId,
      p.msgId,
      error
        ? { generating: false, error: true, content: error, tools }
        : { generating: false, tools },
    )
  }

  window.api.onAiDone(reqId => finish(reqId))
  window.api.onAiError((reqId, msg) => finish(reqId, msg))
}
