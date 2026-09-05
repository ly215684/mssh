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
  /** SSH 会话退出（主进程事件回调） */
  markClosed: (connectionId: string) => void
  /** 恢复上次会话布局 */
  restore: (tabs: SessionTab[], activeTabId: string | null) => Promise<void>
  saveLayout: () => void
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

  markClosed: connectionId => {
    set(s => {
      const cur = s.connSessions[connectionId]
      if (!cur || cur.status === 'closed') return {}
      return {
        connSessions: {
          ...s.connSessions,
          [connectionId]: { sshSessionId: null, info: null, status: 'closed' },
        },
      }
    })
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
