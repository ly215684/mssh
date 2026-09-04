import type { ReactNode } from 'react'

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { label: ReactNode; value: T }[]
  className?: string
}

/** 全局分段选择器（参照设计图「密码 / 密钥」切换样式） */
export function Segmented<T extends string>({ value, onChange, options, className = '' }: SegmentedProps<T>) {
  return (
    <div className={`flex h-8.5 bg-input border border-bd rounded-md overflow-hidden ${className}`}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 text-[13px] transition-colors ${
            value === o.value
              ? 'bg-accent text-accent-contrast font-medium'
              : 'text-dim hover:text-fg hover:bg-hover'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
