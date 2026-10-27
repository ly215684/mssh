import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  PenLine,
  Plus,
  RotateCcw,
  Send,
  Settings as SettingsIcon,
  Square,
  Terminal,
  Trash2,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useAiChatStore, type AiMessage } from '../../stores/aiChatStore'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import type { DictKey } from '../../i18n/zh-CN'
import type { AiAgentContext, AiToolCall } from '../../../electron/shared/types'
import { Markdown } from './Markdown'
import { Button, Spinner, Tooltip, confirm, message } from '../../components/ui'

/** MCP 工具展示元信息（标题与图标） */
const TOOL_META: Record<string, { label: DictKey; icon: LucideIcon }> = {
  run_command: { label: 'ai.toolRunCommand', icon: Terminal },
  read_file: { label: 'ai.toolReadFile', icon: FileText },
  list_directory: { label: 'ai.toolListDirectory', icon: FolderOpen },
  write_file: { label: 'ai.toolWriteFile', icon: PenLine },
}

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
  const activeTab = useSessionStore(s => s.tabs.find(t => t.id === s.activeTabId))
  const connSession = useSessionStore(s =>
    activeTab ? s.connSessions[activeTab.connectionId] : undefined,
  )
  const conn = useConnStore(s =>
    activeTab ? s.connections.find(c => c.id === activeTab.connectionId) : undefined,
  )

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
  const agent = ai.mode === 'agent'
  // 代理模式只能操作当前终端所在的服务器；未连接时不允许发送
  const agentContext: AiAgentContext | undefined =
    agent && conn && connSession?.status === 'connected' && connSession.sshSessionId
      ? {
          sessionId: connSession.sshSessionId,
          host: conn.host,
          username: conn.username,
          connectionName: conn.name,
        }
      : undefined
  const agentBlocked = agent && !agentContext

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
    if (agentBlocked) {
      message.warning(t('ai.needSession'))
      return
    }
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    await send(q, agentContext)
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
        <span
          className={`shrink-0 h-5 px-1.5 flex items-center rounded text-[10px] font-medium ${
            agent
              ? 'bg-accent-dim text-accent border border-accent/30'
              : 'bg-input text-faint border border-bd'
          }`}
        >
          {t(agent ? 'ai.modeAgent' : 'ai.modeChat')}
        </span>
        <div className="flex-1" />
        <Tooltip placement="bottom" label={t('ai.newChat')}>
          <button
            onClick={() => newChat()}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <Plus size={16} />
          </button>
        </Tooltip>
        <Tooltip placement="bottom" label={t('settings.title')}>
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
                chatId={activeChat.id}
                m={m}
                canRegenerate={idx === activeChat.messages.length - 1}
                onRetry={() => retry(agentContext)}
              />
            ))}
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-bd bg-panel/60 px-3 py-2.5">
        {agentBlocked && configured && (
          <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
            {t('ai.needSession')}
          </div>
        )}
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
            placeholder={
              !configured
                ? t('ai.inputDisabledPh')
                : agent
                  ? t('ai.agentInputPh')
                  : t('ai.inputPh')
            }
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
              disabled={!configured || !input.trim() || agentBlocked}
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

/** 单条消息（用户气泡 / 助手 Markdown + 工具调用卡片） */
function MessageBubble({
  chatId,
  m,
  canRegenerate,
  onRetry,
}: {
  chatId: string
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
        ) : (
          <>
            {m.generating && !m.content && (
              <div className="flex items-center gap-2 text-dim text-xs py-1.5">
                <Spinner size={14} />
                {t('ai.thinking')}
              </div>
            )}
            {m.content && <Markdown content={m.content} />}
            {m.tools && m.tools.length > 0 && (
              <div className="space-y-2 mt-2">
                {m.tools.map(call => (
                  <ToolCard key={call.id} chatId={chatId} msgId={m.id} call={call} />
                ))}
              </div>
            )}
            {!m.generating && (m.content || (m.tools?.length ?? 0) > 0) && (
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

/** 工具调用状态文案与图标 */
function ToolStatus({ call }: { call: AiToolCall }) {
  const t = useT()
  if (call.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-warning">
        <Clock size={11} />
        {t('ai.toolPending')}
      </span>
    )
  }
  if (call.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-accent">
        <Spinner size={11} />
        {t('ai.toolRunning')}
      </span>
    )
  }
  if (call.status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-accent">
        <CheckCircle2 size={11} />
        {t('ai.toolDone')}
      </span>
    )
  }
  if (call.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-danger">
        <XCircle size={11} />
        {t('ai.toolError')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-faint">
      <Ban size={11} />
      {t('ai.toolDenied')}
    </span>
  )
}

/** 代理模式工具调用卡片：参数预览 + 用户确认 + 执行结果 */
function ToolCard({
  chatId,
  msgId,
  call,
}: {
  chatId: string
  msgId: string
  call: AiToolCall
}) {
  const t = useT()
  const replyTool = useAiChatStore(s => s.replyTool)
  const meta = TOOL_META[call.name]
  const Icon = meta?.icon ?? Terminal
  const command = typeof call.args.command === 'string' ? call.args.command : ''
  const path = typeof call.args.path === 'string' ? call.args.path : ''
  const content = typeof call.args.content === 'string' ? call.args.content : ''
  const awaiting = call.status === 'pending' && call.needsApproval

  return (
    <div className="rounded-lg border border-bd bg-panel/70 overflow-hidden">
      <div className="flex items-center gap-1.5 h-8 px-2.5 border-b border-bd/60 bg-input/50">
        <Icon size={12} className="shrink-0 text-accent" />
        <span className="text-[12px] font-medium text-fg shrink-0">
          {meta ? t(meta.label) : t('ai.toolUnknown')}
        </span>
        <span className="text-[10px] text-faint mono truncate">{call.name}</span>
        <div className="flex-1" />
        <ToolStatus call={call} />
      </div>

      <div className="px-2.5 py-2 space-y-1.5">
        {call.name === 'run_command' ? (
          <pre className="max-h-32 overflow-auto rounded border border-bd bg-term-bg px-2 py-1.5 text-[11.5px] leading-relaxed text-term-fg whitespace-pre-wrap break-words selectable">
            <span className="text-accent select-none">$ </span>
            {command || t('ai.toolNoArgs')}
          </pre>
        ) : (
          <div className="text-[11.5px] text-dim break-all selectable">
            <span className="text-faint">{t('ai.toolPath')}: </span>
            <span className="mono text-fg">{path || '.'}</span>
          </div>
        )}

        {call.name === 'write_file' && content && (
          <pre className="max-h-28 overflow-auto rounded border border-bd bg-input px-2 py-1.5 text-[11px] leading-relaxed text-dim whitespace-pre-wrap break-words selectable">
            {content.length > 2000 ? `${content.slice(0, 2000)}\n…` : content}
          </pre>
        )}

        {awaiting && (
          <div className="flex items-center gap-2 pt-0.5">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircle2 size={12} />}
              onClick={() => replyTool(chatId, msgId, call.id, true)}
            >
              {t('ai.toolAllow')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Ban size={12} />}
              onClick={() => replyTool(chatId, msgId, call.id, false)}
            >
              {t('ai.toolDeny')}
            </Button>
          </div>
        )}

        {call.status === 'done' || call.status === 'error' || call.status === 'denied' ? (
          <pre className="max-h-44 overflow-auto rounded border border-bd bg-input px-2 py-1.5 text-[11px] leading-relaxed text-dim whitespace-pre-wrap break-words selectable">
            {call.output?.trim() || t('ai.toolNoOutput')}
          </pre>
        ) : null}
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
