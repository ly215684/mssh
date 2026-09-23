import { create } from 'zustand'
import type { ChatMessage } from '../../electron/shared/types'
import { useAppStore } from './appStore'

/** 对话中的一条消息（区别于发送给接口的 ChatMessage，多了 UI 状态） */
export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 助手消息请求失败（content 为错误详情） */
  error?: boolean
  /** 助手消息正在流式生成 */
  generating?: boolean
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
  send: (content: string) => Promise<void>
  /** 停止当前会话正在生成的回复 */
  stop: () => void
  /** 基于最后一条提问重新生成回复 */
  retry: () => void
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
      // 重启后不可能仍在生成，重置 generating 标志
      chats: (parsed.chats ?? []).map(c => ({
        ...c,
        messages: (c.messages ?? []).map(m => ({ ...m, generating: false })),
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

/** 组装发送给模型的消息：系统提示词 + 最近成功的历史 */
function buildMessages(history: AiMessage[], systemPrompt: string): ChatMessage[] {
  const recent = history
    .filter(m => !m.error && m.content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content }))
  const sys = systemPrompt.trim()
  return sys ? [{ role: 'system' as const, content: sys }, ...recent] : recent
}

function aiConfigured(): boolean {
  const ai = useAppStore.getState().settings.ai
  return Boolean(ai.apiKey.trim() && ai.baseUrl.trim() && ai.model.trim())
}

/** 发起主进程流式请求并登记 reqId */
async function launch(chatId: string, msgId: string, history: AiMessage[]) {
  const { systemPrompt } = useAppStore.getState().settings.ai
  try {
    const reqId = await window.api.aiStart(buildMessages(history, systemPrompt))
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

  send: async content => {
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
    await launch(chatId, aiMsgId, nextMessages)
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

  retry: () => {
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
    const nextMessages = [...msgs, { id: aiMsgId, role: 'assistant' as const, content: '', generating: true }]
    updateChat(chatId, c => ({ ...c, messages: nextMessages }))
    void launch(chatId, aiMsgId, nextMessages)
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

  const finish = (reqId: string, error?: string) => {
    const p = pending.get(reqId)
    if (!p) return
    pending.delete(reqId)
    patchMessage(
      p.chatId,
      p.msgId,
      error
        ? { generating: false, error: true, content: error }
        : { generating: false },
    )
  }

  window.api.onAiDone(reqId => finish(reqId))
  window.api.onAiError((reqId, msg) => finish(reqId, msg))
}
