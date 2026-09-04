import { create } from 'zustand'
import type {
  AppSettings,
  Language,
  SshSettings,
  TerminalSettings,
  ThemeMode,
} from '../../electron/shared/types'
import { DEFAULT_SETTINGS } from '../../electron/shared/types'

interface AppState {
  settings: AppSettings
  loaded: boolean
  dataDir: string
  hydrate: (settings: AppSettings, dataDir: string) => void
  setSettings: (patch: Partial<AppSettings>) => void
  setTheme: (t: ThemeMode) => void
  setLanguage: (l: Language) => void
  setTerminal: (patch: Partial<TerminalSettings>) => void
  setSsh: (patch: Partial<SshSettings>) => void
}

/** 应用设置 store（语言/主题等，持久化由主进程 configStore 负责） */
export const useAppStore = create<AppState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  dataDir: '',

  hydrate: (settings, dataDir) => set({ settings, dataDir, loaded: true }),

  setSettings: patch => {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    window.api.saveSettings(settings)
  },

  setTheme: theme => get().setSettings({ theme }),

  setLanguage: language => get().setSettings({ language }),

  setTerminal: patch => {
    const settings = { ...get().settings, terminal: { ...get().settings.terminal, ...patch } }
    set({ settings })
    window.api.saveSettings(settings)
  },

  setSsh: patch => {
    const settings = { ...get().settings, ssh: { ...get().settings.ssh, ...patch } }
    set({ settings })
    window.api.saveSettings(settings)
  },
}))
