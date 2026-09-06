import { create } from 'zustand'
import type { TransferItem } from '../../electron/shared/types'

interface TransferState {
  /** 最近的任务在尾部 */
  items: TransferItem[]
  /** 队列面板是否展开 */
  expanded: boolean
  setExpanded: (v: boolean) => void
  /** 清除已完成/失败/取消的记录 */
  clearFinished: () => void
}

/** 传输队列 store（数据来自主进程 transfer:progress 事件） */
export const useTransferStore = create<TransferState>((set) => ({
  items: [],
  expanded: false,

  setExpanded: v => set({ expanded: v }),

  clearFinished: () =>
    set(s => ({ items: s.items.filter(i => i.status === 'pending' || i.status === 'active') })),
}))

let started = false

/** 订阅主进程传输事件（幂等，应用启动时调用一次） */
export function startTransferListener(): void {
  if (started) return
  started = true
  window.api.onTransfer(item => {
    useTransferStore.setState(s => {
      const idx = s.items.findIndex(i => i.id === item.id)
      if (idx === -1) return { items: [...s.items, item] }
      const items = s.items.slice()
      items[idx] = item
      return { items }
    })
  })
}

/** 取消传输任务（等待中立即取消；进行中的中断引擎） */
export function cancelTransfer(id: string): void {
  void window.api.cancelTransfer(id)
}

/** 队列概要：进行中数量与总速度 */
export function queueSummary(items: TransferItem[]): { activeCount: number; speed: number } {
  let activeCount = 0
  let speed = 0
  for (const i of items) {
    if (i.status === 'active' || i.status === 'pending') {
      activeCount++
      speed += i.speed
    }
  }
  return { activeCount, speed }
}
