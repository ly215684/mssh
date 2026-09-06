import { create } from 'zustand'
import type { SessionTab, SshSessionInfo } from '../../electron/shared/types'
import { useConnStore } from './connStore'
import { useAppStore } from './appStore'
import { errorAlert } from '../components/ui'
import { getGlobalT } from '../i18n/I18nProvider'

export type ConnSessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

/** 每个连接共享一个 SSH 会话（终端与 SFTP 标签共用） */
interface ConnSession {
  sshSessionId: string | null
  info: SshSessionInfo | null
  status: ConnSessionStatus
  error?: string
  /** 自动重连：即将/正在进行的重试序号（1 起）；undefined = 未在自动重连 */
  retryAttempt?: number
}

interface SessionState {
  tabs: SessionTab[]
  activeTabId: string | null
  /** key: connectionId */
  connSessions: Record<string, ConnSession>
  /** 置空某个标签的虚拟终端重载计数（用于重连刷新） */
  openTerminal: (connectionId: string) => Promise<void>
  openSftp: (connectionId: string) => Promise<void>
  openDocker: (connectionId: string) => Promise<void>
  openCron: (connectionId: string) => Promise<void>
  closeTab: (tabId: string) => void
  setActive: (tabId: string) => void
  reconnect: (connectionId: string) => Promise<void>
  disconnect: (connectionId: string) => Promise<void>
  /** SSH 会话退出（主进程事件回调）；reason 为可读断开原因 */
  markClosed: (connectionId: string, reason?: string) => void
  /** 恢复上次会话布局 */
  restore: (tabs: SessionTab[], activeTabId: string | null) => Promise<void>
  saveLayout: () => void
  /** 停止自动重连（保留 closed 状态，可手动重连） */
  stopRetry: (connectionId: string) => void
}

function tabTitle(type: SessionTab['type'], connName: string): string {
  if (type === 'sftp') return 'SFTP'
  if (type === 'docker') return 'Docker'
  if (type === 'cron') return 'Cron'
  return connName
}

async function ensureSession(
  get: () => SessionState,
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  connectionId: string,
): Promise<string | null> {
  const state = get()
  const existing = state.connSessions[connectionId]
  if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
    return existing.sshSessionId
  }
  // 手动连接优先：取消进行中的自动重连，避免双重连接
  if (existing?.retryAttempt !== undefined) {
    clearRetryTimer(connectionId)
  }

  const connection = useConnStore.getState().getConnection(connectionId)
  if (!connection) return null

  // 置为 connecting
  set(s => ({
    connSessions: {
      ...s.connSessions,
      [connectionId]: { sshSessionId: null, info: null, status: 'connecting' },
    },
  }))

  try {
    const info = await window.api.sshConnect(connection, useAppStore.getState().settings.ssh)
    set(s => ({
      connSessions: {
        ...s.connSessions,
        [connectionId]: { sshSessionId: info.sessionId, info, status: 'connected' },
      },
    }))
    return info.sessionId
  } catch (e) {
    set(s => ({
      connSessions: {
        ...s.connSessions,
        [connectionId]: {
          sshSessionId: null,
          info: null,
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        },
      },
    }))
    void errorAlert(getGlobalT()('term.connFailedTitle'), e)
    return null
  }
}

/** 自动重连：最多尝试次数与退避间隔（5s 起、翻倍、上限 60s） */
export const SSH_RETRY_MAX_ATTEMPTS = 10
function retryDelay(attempt: number): number {
  return Math.min(5000 * 2 ** (attempt - 1), 60000)
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearRetryTimer(connectionId: string) {
  const timer = retryTimers.get(connectionId)
  if (timer) clearTimeout(timer)
  retryTimers.delete(connectionId)
}

function patchConnSession(connectionId: string, patch: Partial<ConnSession>) {
  useSessionStore.setState(s => {
    const cur = s.connSessions[connectionId]
    if (!cur) return {}
    return {
      connSessions: { ...s.connSessions, [connectionId]: { ...cur, ...patch } },
    }
  })
}

/** 排定第 attempt 次重试；超过上限则放弃（回到手动重连） */
function scheduleRetry(connectionId: string, attempt: number) {
  clearRetryTimer(connectionId)
  if (attempt > SSH_RETRY_MAX_ATTEMPTS) {
    patchConnSession(connectionId, { retryAttempt: undefined })
    return
  }
  patchConnSession(connectionId, { retryAttempt: attempt })
  retryTimers.set(
    connectionId,
    setTimeout(() => void attemptReconnect(connectionId, attempt), retryDelay(attempt)),
  )
}

/** 单次重连尝试：静默进行（不弹错误弹窗），失败后继续退避 */
async function attemptReconnect(connectionId: string, attempt: number) {
  const cs = useSessionStore.getState().connSessions[connectionId]
  // 已被取消 / 手动接管 / 标签已全部关闭
  if (!cs || cs.retryAttempt === undefined || cs.status !== 'closed') return
  const connection = useConnStore.getState().getConnection(connectionId)
  if (!connection) return

  patchConnSession(connectionId, { status: 'connecting', error: undefined })
  try {
    const info = await window.api.sshConnect(connection, useAppStore.getState().settings.ssh)
    patchConnSession(connectionId, {
      sshSessionId: info.sessionId,
      info,
      status: 'connected',
      retryAttempt: undefined,
    })
    clearRetryTimer(connectionId)
  } catch (e) {
    patchConnSession(connectionId, {
      sshSessionId: null,
      info: null,
      status: 'closed',
      error: e instanceof Error ? e.message : String(e),
    })
    scheduleRetry(connectionId, attempt + 1)
  }
}

/** 全局订阅 SSH 退出事件：标签卸载时也不丢事件，并触发自动重连 */
let sshEventsBound = false
export function initSshEvents() {
  if (sshEventsBound) return
  sshEventsBound = true
  window.api.onAnySshExit((sessionId, reason) => {
    const { connSessions, markClosed } = useSessionStore.getState()
    const entry = Object.entries(connSessions).find(([, v]) => v.sshSessionId === sessionId)
    if (entry) markClosed(entry[0], reason)
  })
}

/** 会话标签 store：标签生命周期 + SSH 连接生命周期 */
export const useSessionStore = create<SessionState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  connSessions: {},

  openTerminal: async connectionId => {
    // 已存在终端标签则直接激活
    const existed = get().tabs.find(t => t.connectionId === connectionId && t.type === 'terminal')
    if (existed) {
      set({ activeTabId: existed.id })
      return
    }
    const tabId = `${connectionId}-term`
    await ensureSession(get, set, connectionId)
    const connName = useConnStore.getState().getConnection(connectionId)?.name ?? 'SSH'
    set(s => {
      if (s.tabs.some(t => t.id === tabId)) return {}
      return {
        tabs: [...s.tabs, { id: tabId, connectionId, type: 'terminal', title: tabTitle('terminal', connName) }],
        activeTabId: tabId,
      }
    })
    get().saveLayout()
  },

  openSftp: async connectionId => {
    const existed = get().tabs.find(t => t.connectionId === connectionId && t.type === 'sftp')
    if (existed) {
      set({ activeTabId: existed.id })
      return
    }
    const tabId = `${connectionId}-sftp`
    await ensureSession(get, set, connectionId)
    set(s => {
      if (s.tabs.some(t => t.id === tabId)) return {}
      return {
        tabs: [...s.tabs, { id: tabId, connectionId, type: 'sftp', title: tabTitle('sftp', '') }],
        activeTabId: tabId,
      }
    })
    get().saveLayout()
  },

  openDocker: async connectionId => {
    const existed = get().tabs.find(t => t.connectionId === connectionId && t.type === 'docker')
    if (existed) {
      set({ activeTabId: existed.id })
      return
    }
    const tabId = `${connectionId}-docker`
    await ensureSession(get, set, connectionId)
    set(s => {
      if (s.tabs.some(t => t.id === tabId)) return {}
      return {
        tabs: [...s.tabs, { id: tabId, connectionId, type: 'docker', title: tabTitle('docker', '') }],
        activeTabId: tabId,
      }
    })
    get().saveLayout()
  },

  openCron: async connectionId => {
    const existed = get().tabs.find(t => t.connectionId === connectionId && t.type === 'cron')
    if (existed) {
      set({ activeTabId: existed.id })
      return
    }
    const tabId = `${connectionId}-cron`
    await ensureSession(get, set, connectionId)
    set(s => {
      if (s.tabs.some(t => t.id === tabId)) return {}
      return {
        tabs: [...s.tabs, { id: tabId, connectionId, type: 'cron', title: tabTitle('cron', '') }],
        activeTabId: tabId,
      }
    })
    get().saveLayout()
  },

  closeTab: tabId => {
    const tab = get().tabs.find(t => t.id === tabId)
    if (!tab) return
    const tabs = get().tabs.filter(t => t.id !== tabId)

    // 同连接的所有标签都关闭时断开 SSH
    const stillUsed = tabs.some(t => t.connectionId === tab.connectionId)
    const patch: Partial<SessionState> = { tabs }
    if (get().activeTabId === tabId) {
      const idx = get().tabs.findIndex(t => t.id === tabId)
      patch.activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
    }
    set(patch)

    if (!stillUsed) {
      const session = get().connSessions[tab.connectionId]
      if (session?.sshSessionId) {
        window.api.sshDisconnect(session.sshSessionId)
      }
      clearRetryTimer(tab.connectionId)
      set(s => {
        const connSessions = { ...s.connSessions }
        delete connSessions[tab.connectionId]
        return { connSessions }
      })
    }
    get().saveLayout()
  },

  setActive: tabId => {
    set({ activeTabId: tabId })
    get().saveLayout()
  },

  reconnect: async connectionId => {
    clearRetryTimer(connectionId)
    const session = get().connSessions[connectionId]
    if (session?.sshSessionId) {
      window.api.sshDisconnect(session.sshSessionId)
    }
    set(s => {
      const connSessions = { ...s.connSessions }
      delete connSessions[connectionId]
      return { connSessions }
    })
    await ensureSession(get, set, connectionId)
  },

  disconnect: async connectionId => {
    clearRetryTimer(connectionId)
    const session = get().connSessions[connectionId]
    if (session?.sshSessionId) {
      window.api.sshDisconnect(session.sshSessionId)
    }

    // 关闭该连接下的所有标签（终端 / SFTP / Docker）
    const allTabs = get().tabs
    const remaining = allTabs.filter(t => t.connectionId !== connectionId)
    const connSessions = { ...get().connSessions }
    delete connSessions[connectionId]
    const patch: Partial<SessionState> = {
      tabs: remaining,
      connSessions,
    }

    const activeTabId = get().activeTabId
    if (activeTabId && allTabs.some(t => t.id === activeTabId && t.connectionId === connectionId)) {
      const idx = allTabs.findIndex(t => t.id === activeTabId)
      patch.activeTabId = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null
    }

    set(patch)
    get().saveLayout()
  },

  markClosed: (connectionId, reason) => {
    const autoReconnect = useAppStore.getState().settings.ssh.autoReconnect
    set(s => {
      const cur = s.connSessions[connectionId]
      if (!cur || cur.status === 'closed') return {}
      return {
        connSessions: {
          ...s.connSessions,
          [connectionId]: {
            sshSessionId: null,
            info: null,
            status: 'closed',
            // 断开原因（心跳超时/连接重置/服务器端退出等），供界面展示
            error: reason,
            // 意外退出：按设置进入自动重连流程
            retryAttempt: autoReconnect ? 0 : undefined,
          },
        },
      }
    })
    if (autoReconnect) scheduleRetry(connectionId, 1)
  },

  stopRetry: connectionId => {
    clearRetryTimer(connectionId)
    patchConnSession(connectionId, { retryAttempt: undefined })
  },

  restore: async (tabs, activeTabId) => {
    for (const tab of tabs) {
      if (tab.type === 'terminal') await get().openTerminal(tab.connectionId)
      else if (tab.type === 'docker') await get().openDocker(tab.connectionId)
      else if (tab.type === 'cron') await get().openCron(tab.connectionId)
      else await get().openSftp(tab.connectionId)
    }
    if (activeTabId) set({ activeTabId })
  },

  saveLayout: () => {
    const { tabs, activeTabId } = get()
    window.api.saveLayout({ tabs, activeTabId })
  },
}))

/** 获取连接会话（供组件 hooks 使用） */
export function useConnSession(connectionId: string): ConnSession | undefined {
  return useSessionStore(s => s.connSessions[connectionId])
}
