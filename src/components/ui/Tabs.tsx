import type { ReactNode } from 'react'

interface TabsProps<T extends string> {
  items: { key: T; label: ReactNode; icon?: ReactNode }[]
  active: T
  onChange: (key: T) => void
  /** 垂直模式（设置弹窗左侧导航） */
  vertical?: boolean
  className?: string
}

/** 全局标签页组件 */
export function Tabs<T extends string>({ items, active, onChange, vertical, className = '' }: TabsProps<T>) {
  if (vertical) {
    return (
      <div className={`flex flex-col gap-1 ${className}`}>
        {items.map(it => (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            className={`flex items-center gap-2.5 h-9 px-3 rounded-md text-[13px] transition-colors text-left ${
              active === it.key ? 'bg-accent-dim text-accent font-medium' : 'text-dim hover:text-fg hover:bg-hover'
            }`}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className={`flex gap-1 border-b border-bd ${className}`}>
      {items.map(it => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`flex items-center gap-2 h-9 px-4 text-[13px] transition-colors border-b-2 -mb-px ${
            active === it.key
              ? 'text-accent border-accent font-medium'
              : 'text-dim border-transparent hover:text-fg'
          }`}
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  )
}
