import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Bot,
  ChevronDown,
  Copy,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Send,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useAiChatStore, type AiMessage } from '../../stores/aiChatStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import { Markdown } from './Markdown'
import { Button, Spinner, Tooltip, confirm, message } from '../../components/ui'

/** 空会话时展示的运维场景快捷提问（SSH 客户端场景） */
function suggestions(t: ReturnType<typeof useT>): string[] {
  return [t('ai.suggestDisk'), t('ai.suggestLargeFile'), t('ai.suggestPort'), t('ai.suggestCpu')]
}

/** AI 助手悬浮面板：仅终端页挂载，右侧浮层（不占用标签） */
export function AiFloatingPanel() {
  const t = useT()
  const panelOpen = useUiStore(s => s.aiPanelOpen)
  const setPanelOpen = useUiStore(s => s.setAiPanelOpen)
  const setSettingsOpen = useUiStore(s => s.setSettingsOpen)
  const ai = useAppStore(s => s.settings.ai)

  const chats = useAiChatStore(s => s.chats)
  const activeChatId = useAiChatStore(s => s.activeChatId)
  const newChat = useAiChatStore(s => s.newChat)
  const deleteChat = useAiChatStore(s => s.deleteChat)
  const setActive = useAiChatStore(s => s.setActive)
  const send = useAiChatStore(s => s.send)
  const stop = useAiChatStore(s => s.stop)
  const retry = useAiChatStore(s => s.retry)

  const [listOpen, setListOpen] = useState(false)
  const [input, setInput] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const activeChat = chats.find(c => c.id === activeChatId) ?? null
  const generating = activeChat?.messages.some(m => m.generating) ?? false
  const configured = Boolean(ai.apiKey.trim() && ai.baseUrl.trim() && ai.model.trim())

  // 流式增量 / generating 变化时，若用户停留在底部则自动滚到底
  const lastLen = activeChat?.messages[activeChat.messages.length - 1]?.content.length ?? 0
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastLen, generating])

  // 打开面板或切换会话时定位到最新消息并聚焦输入框
  useEffect(() => {
    if (panelOpen) {
      stick.current = true
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      taRef.current?.focus()
    }
  }, [panelOpen, activeChatId])

  if (!panelOpen) return null

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }

  async function doSend(text?: string) {
    const q = (text ?? input).trim()
    if (!q || generating) return
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    await send(q)
  }

  return (
    <div className="absolute top-0 right-0 bottom-0 z-30 w-[400px] max-w-[92%] flex flex-col bg-panel border-l border-bd shadow-2xl shadow-black/40 min-w-0">
      {/* 顶栏：会话切换 + 新建 + 设置 + 关闭 */}
      <div className="relative flex items-center gap-1 h-9 px-2 border-b border-bd shrink-0">
        <button
          onClick={() => setListOpen(v => !v)}
          className="flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-md text-[13px] text-dim hover:text-fg hover:bg-hover transition-colors min-w-0"
        >
          <MessageSquarePlus size={14} className="shrink-0 text-accent" />
          <span className="truncate max-w-[180px]">
            {activeChat?.title || t('ai.untitled')}
          </span>
          <ChevronDown size={13} className="shrink-0 opacity-70" />
        </button>
        <div className="flex-1" />
        <Tooltip label={t('ai.newChat')}>
          <button
            onClick={() => newChat()}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <Plus size={16} />
          </button>
        </Tooltip>
        <Tooltip label={t('settings.title')}>
          <button
            onClick={() => setSettingsOpen(true)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <SettingsIcon size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('common.close')}>
          <button
            onClick={() => setPanelOpen(false)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </Tooltip>

        {/* 会话切换弹层 */}
        {listOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setListOpen(false)} />
            <div className="absolute top-8 left-2 z-50 w-64 max-h-80 flex flex-col rounded-lg border border-bd bg-elevated shadow-xl overflow-hidden">
              <button
                onClick={() => {
                  newChat()
                  setListOpen(false)
                }}
                className="flex items-center gap-2 h-8 px-3 text-[13px] text-accent hover:bg-accent-dim transition-colors shrink-0"
              >
                <Plus size={14} />
                {t('ai.newChat')}
              </button>
              <div className="flex-1 overflow-y-auto border-t border-bd py-1">
                {chats.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-faint">{t('ai.noChats')}</div>
                )}
                {chats.map(c => (
                  <div
                    key={c.id}
                    onClick={() => {
                      setActive(c.id)
                      setListOpen(false)
                    }}
                    className={`group flex items-center gap-2 h-8 px-3 text-[13px] cursor-pointer transition-colors ${
                      c.id === activeChatId
                        ? 'bg-active text-fg'
                        : 'text-dim hover:text-fg hover:bg-hover'
                    }`}
                  >
                    <span className="flex-1 truncate">{c.title || t('ai.untitled')}</span>
                    <button
                      onClick={async e => {
                        e.stopPropagation()
                        const ok = await confirm({ title: t('ai.deleteChatConfirm'), danger: true })
                        if (ok) deleteChat(c.id)
                      }}
                      className="opacity-0 group-hover:opacity-100 text-dim hover:text-danger transition-opacity shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 消息区 / 欢迎页 / 配置引导 */}
      {!configured ? (
        <NeedSetup onGo={() => setSettingsOpen(true)} />
      ) : !activeChat || activeChat.messages.length === 0 ? (
        <Welcome onPick={q => void doSend(q)} />
      ) : (
        <div
          ref={scrollRef}
          onScroll={e => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
          className="flex-1 min-h-0 overflow-y-auto"
        >
          <div className="px-4 py-4 space-y-4">
            {activeChat.messages.map((m, idx) => (
              <MessageBubble
                key={m.id}
                m={m}
                canRegenerate={idx === activeChat.messages.length - 1}
                onRetry={retry}
              />
            ))}
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-bd bg-panel/60 px-3 py-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-bd bg-input p-2 transition-colors focus-within:border-accent">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            disabled={!configured}
            onChange={e => {
              setInput(e.target.value)
              autoGrow()
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void doSend()
              }
            }}
            placeholder={configured ? t('ai.inputPh') : t('ai.inputDisabledPh')}
            className="flex-1 resize-none bg-transparent px-1 py-1 text-[13px] leading-relaxed text-fg placeholder:text-faint outline-none max-h-40 disabled:opacity-50"
          />
          {generating ? (
            <Button variant="danger" size="sm" icon={<Square size={12} />} onClick={stop}>
              {t('ai.stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="px-2"
              disabled={!configured || !input.trim()}
              onClick={() => void doSend()}
            >
              <Send size={13} />
            </Button>
          )}
        </div>
        <div className="mt-1 text-center text-[11px] text-faint">{t('ai.enterHint')}</div>
      </div>
    </div>
  )
}

/** 未配置 API 时的引导 */
function NeedSetup({ onGo }: { onGo: () => void }) {
  const t = useT()
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-5">
      <span className="size-12 rounded-2xl bg-accent-dim text-accent flex items-center justify-center">
        <Bot size={24} />
      </span>
      <div className="text-[15px] font-medium text-fg">{t('ai.setupTitle')}</div>
      <div className="text-xs text-dim text-center leading-relaxed">{t('ai.setupDesc')}</div>
      <Button variant="primary" icon={<SettingsIcon size={14} />} className="mt-1" onClick={onGo}>
        {t('ai.goSetup')}
      </Button>
    </div>
  )
}

/** 已配置但当前无消息：欢迎语 + 快捷提问 */
function Welcome({ onPick }: { onPick: (q: string) => void }) {
  const t = useT()
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="px-4 py-6">
        <div className="flex items-center gap-2.5 mb-2">
          <span className="size-9 rounded-xl bg-accent-dim text-accent flex items-center justify-center shrink-0">
            <Bot size={18} />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-fg">{t('ai.welcomeTitle')}</div>
            <div className="text-[11px] text-faint truncate">{t('ai.welcomeDesc')}</div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 mt-4">
          {suggestions(t).map(q => (
            <button
              key={q}
              onClick={() => onPick(q)}
              className="text-left text-[12.5px] text-dim border border-bd rounded-lg px-3 py-2 hover:border-accent hover:text-fg hover:bg-accent-dim/40 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 单条消息（用户气泡 / 助手 Markdown） */
function MessageBubble({
  m,
  canRegenerate,
  onRetry,
}: {
  m: AiMessage
  canRegenerate: boolean
  onRetry: () => void
}) {
  const t = useT()

  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-lg bg-accent-dim border border-accent/25 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap selectable text-fg">
          {m.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <span className="size-7 mt-0.5 rounded-md bg-accent-dim text-accent flex items-center justify-center shrink-0">
        <Bot size={15} />
      </span>
      <div className="min-w-0 flex-1">
        {m.error ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
            <div className="flex items-center gap-1.5 text-danger text-[13px] font-medium">
              <AlertCircle size={14} />
              {t('ai.failed')}
            </div>
            <div className="mt-1 text-xs text-danger/80 break-all selectable">{m.content}</div>
            <button
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1 text-xs text-dim hover:text-fg"
            >
              <RotateCcw size={12} />
              {t('ai.retry')}
            </button>
          </div>
        ) : m.generating && !m.content ? (
          <div className="flex items-center gap-2 text-dim text-xs py-1.5">
            <Spinner size={14} />
            {t('ai.thinking')}
          </div>
        ) : (
          <>
            <Markdown content={m.content} />
            {!m.generating && (
              <div className="flex items-center gap-1 mt-1.5">
                <IconAction
                  title={t('ai.copyMsg')}
                  onClick={() => {
                    void window.api.clipboardWriteText(m.content)
                    message.success(t('msg.copied'))
                  }}
                >
                  <Copy size={13} />
                </IconAction>
                {canRegenerate && (
                  <IconAction title={t('ai.retry')} onClick={onRetry}>
                    <RotateCcw size={13} />
                  </IconAction>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function IconAction({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="size-6 flex items-center justify-center rounded text-faint hover:text-fg hover:bg-hover transition-colors"
    >
      {children}
    </button>
  )
}
