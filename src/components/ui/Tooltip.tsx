import type { ReactNode } from 'react'

interface TooltipProps {
  label: ReactNode
  children: ReactNode
  className?: string
  /**
   * 气泡方向：默认显示在按钮上方。
   * 位于内容区顶部工具栏时请用 bottom，否则会被外层 overflow-hidden 裁剪而不可见。
   */
  placement?: 'top' | 'bottom'
}

/** 全局工具提示（hover 延迟显示） */
export function Tooltip({ label, children, className = '', placement = 'top' }: TooltipProps) {
  const pos =
    placement === 'bottom'
      ? 'top-full mt-1.5 left-1/2 -translate-x-1/2'
      : '-top-1 left-1/2 -translate-x-1/2 -translate-y-full'
  return (
    <span className={`relative inline-flex group/tt ${className}`}>
      {children}
      <span
        className={`pointer-events-none absolute ${pos} z-[2000] whitespace-nowrap bg-elevated border border-bd text-fg text-xs rounded-md px-2 py-1 shadow-pop opacity-0 group-hover/tt:opacity-100 transition-opacity delay-300`}
      >
        {label}
      </span>
    </span>
  )
}
