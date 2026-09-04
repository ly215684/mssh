import type { ReactNode } from 'react'

interface TooltipProps {
  label: ReactNode
  children: ReactNode
  className?: string
}

/** 全局工具提示（hover 延迟显示） */
export function Tooltip({ label, children, className = '' }: TooltipProps) {
  return (
    <span className={`relative inline-flex group/tt ${className}`}>
      {children}
      <span className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full z-[2000] whitespace-nowrap bg-elevated border border-bd text-fg text-xs rounded-md px-2 py-1 shadow-pop opacity-0 group-hover/tt:opacity-100 transition-opacity delay-300">
        {label}
      </span>
    </span>
  )
}
