import { create } from 'zustand'
import type { UpdateEvent } from '../../electron/shared/types'

export type UpdatePhase =
  | 'idle' // 未检查
  | 'checking' // 检查中
  | 'available' // 有新版本，待确认下载
  | 'none' // 已是最新
  | 'downloading' // 下载中
  | 'downloaded' // 下载完成，待安装
  | 'error' // 出错

interface UpdateState {
  phase: UpdatePhase
  /** true = 启动时自动检查（无新版本时不打扰用户） */
  silent: boolean
  percent: number
  bytesPerSecond: number
  /** 新版本号 */
  version: string | null
  errorMsg: string | null
  /** 更新器是否可用（dev 下为 false） */
  active: boolean

  check: (silent: boolean) => Promise<void>
  download: () => void
  install: () => void
  dismiss: () => void
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: 'idle',
  silent: true,
  percent: 0,
  bytesPerSecond: 0,
  version: null,
  errorMsg: null,
  active: false,

  check: async silent => {
    if (get().phase === 'checking' || get().phase === 'downloading') return
    set({ phase: 'checking', silent, errorMsg: null })
    const latest = await window.api.updateCheck()
    // 有新版本时等待 'available' 事件驱动 UI；无版本返回且无事件则由事件流收尾
    if (!silent && latest !== null && get().phase === 'checking') {
      // 事件尚未到达的兜底：保持 checking，事件到达后会切走
    }
  },

  download: () => {
    set({ phase: 'downloading', percent: 0 })
    window.api.updateDownload()
  },

  install: () => {
    window.api.updateInstall()
  },

  dismiss: () => {
    const { phase } = get()
    if (phase === 'checking' || phase === 'downloading') return
    set({ phase: 'idle' })
  },
}))

let listenerStarted = false

/** 订阅主进程更新事件（App 启动后调用一次） */
export function startUpdateListener() {
  if (listenerStarted) return
  listenerStarted = true

  void window.api.updateActive().then(active => {
    useUpdateStore.setState({ active })
  })

  window.api.onUpdateEvent((e: UpdateEvent) => {
    const { silent } = useUpdateStore.getState()
    switch (e.type) {
      case 'checking':
        useUpdateStore.setState({ phase: 'checking' })
        break
      case 'available':
        useUpdateStore.setState({ phase: 'available', version: e.payload?.version ?? null })
        break
      case 'not-available':
        useUpdateStore.setState({ phase: 'none' })
        if (silent) setTimeout(() => useUpdateStore.setState({ phase: 'idle' }), 1500)
        break
      case 'progress':
        useUpdateStore.setState({
          phase: 'downloading',
          percent: e.payload?.percent ?? 0,
          bytesPerSecond: e.payload?.bytesPerSecond ?? 0,
        })
        break
      case 'downloaded':
        useUpdateStore.setState({
          phase: 'downloaded',
          version: e.payload?.version ?? useUpdateStore.getState().version,
        })
        break
      case 'error':
        useUpdateStore.setState({ phase: 'error', errorMsg: e.payload?.message ?? 'Unknown error' })
        break
    }
  })
}
