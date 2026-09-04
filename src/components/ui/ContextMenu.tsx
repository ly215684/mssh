import { useCallback } from 'react'
import { create } from 'zustand'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MenuPanel, type MenuItem } from './Dropdown'

interface CtxMenuState {
  x: number
  y: number
  items: MenuItem[]
  onPick: (key: string) => void
}

interface CtxStore {
  menu: CtxMenuState | null
  open: (menu: CtxMenuState) => void
  close: () => void
}

/** 全局右键菜单状态（单例，避免各组件漏渲染菜单节点） */
export const useCtxStore = create<CtxStore>((set) => ({
  menu: null,
  open: menu => set({ menu }),
  close: () => set({ menu: null }),
}))

/** 右键菜单 hook：任意组件调用 openContextMenu 即可弹出，无需自行渲染节点 */
export function useContextMenu() {
  const openContextMenu = useCallback(
    (e: ReactMouseEvent, items: MenuItem[], onPick: (key: string) => void) => {
      e.preventDefault()
      e.stopPropagation()
      useCtxStore.getState().open({ x: e.clientX, y: e.clientY, items, onPick })
    },
    [],
  )

  const closeContextMenu = useCallback(() => useCtxStore.getState().close(), [])

  // 兼容旧调用方渲染 {contextMenu} 的写法（现在统一由 ContextMenuHost 渲染）
  const contextMenu = null

  return { openContextMenu, closeContextMenu, contextMenu }
}

/** 全局右键菜单挂载点：App 根部渲染一次 */
export function ContextMenuHost() {
  const menu = useCtxStore(s => s.menu)
  const close = useCtxStore(s => s.close)

  if (!menu) return null

  return (
    <MenuPanel
      key={`${menu.x}:${menu.y}:${menu.items.length}`}
      anchor={{ left: menu.x, right: menu.x, top: menu.y, bottom: menu.y }}
      items={menu.items}
      minWidth={150}
      onClose={close}
      onPick={key => {
        menu.onPick(key)
        close()
      }}
    />
  )
}
