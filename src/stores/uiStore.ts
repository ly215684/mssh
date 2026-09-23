import { create } from 'zustand'
import type { Connection } from '../../electron/shared/types'

interface UiState {
  /** 新建(null)/编辑(connection)/关闭(undefined) 连接弹窗 */
  editingConn: Connection | null
  newConnOpen: boolean
  quickConnOpen: boolean
  settingsOpen: boolean
  /** AI 助手悬浮面板展开状态（仅终端页可见，全局保持开关状态） */
  aiPanelOpen: boolean
  openNewConn: () => void
  openEditConn: (conn: Connection) => void
  closeConnModal: () => void
  setQuickConnOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  toggleAiPanel: () => void
  setAiPanelOpen: (open: boolean) => void
}

/** 全局 UI 状态（弹窗开关） */
export const useUiStore = create<UiState>((set) => ({
  editingConn: null,
  newConnOpen: false,
  quickConnOpen: false,
  settingsOpen: false,
  aiPanelOpen: false,

  openNewConn: () => set({ editingConn: null, newConnOpen: true }),
  openEditConn: conn => set({ editingConn: conn, newConnOpen: true }),
  closeConnModal: () => set({ editingConn: null, newConnOpen: false, quickConnOpen: false }),
  setQuickConnOpen: open => set({ quickConnOpen: open }),
  setSettingsOpen: open => set({ settingsOpen: open }),
  toggleAiPanel: () => set(s => ({ aiPanelOpen: !s.aiPanelOpen })),
  setAiPanelOpen: open => set({ aiPanelOpen: open }),
}))
