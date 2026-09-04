import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 浮层锚点矩形（与 DOMRect 兼容的最小结构） */
export interface AnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

interface FloatingProps {
  anchor: AnchorRect
  onClose: () => void
  children: ReactNode
  /** 与锚点对齐方式 */
  align?: 'start' | 'end'
  /** 最小宽度，默认与锚点同宽 */
  minWidth?: number
  /** 顶部偏移 */
  offset?: number
}

/**
 * 全局浮层容器：portal 渲染、自动翻转（屏幕边缘）、
 * 点击外部 / Esc / 滚动时关闭。Dropdown、Select、ContextMenu 共用。
 */
export function Floating({ anchor, onClose, children, align = 'start', minWidth, offset = 4 }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
    zIndex: 1000,
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = align === 'end' ? anchor.right - rect.width : anchor.left
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))
    let top = anchor.bottom + offset
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - rect.height - offset)
    }
    setStyle({
      position: 'fixed',
      left,
      top,
      visibility: 'visible',
      minWidth: minWidth ?? anchor.right - anchor.left,
      zIndex: 1000,
    })
  }, [anchor, align, minWidth, offset])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = () => onClose()
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('click', onDocClick, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} style={style} className="animate-msg-in">
      {children}
    </div>,
    document.body,
  )
}
