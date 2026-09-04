import { useRef, useState, type ReactNode } from 'react'
import { Floating, type AnchorRect } from './Floating'

export interface MenuItem {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** 显示为分隔线 */
  divider?: boolean
}

interface MenuPanelProps {
  anchor: AnchorRect
  items: MenuItem[]
  onClose: () => void
  onPick: (key: string) => void
  align?: 'start' | 'end'
  minWidth?: number
}

/** 菜单面板（Dropdown 与 ContextMenu 共用） */
export function MenuPanel({ anchor, items, onClose, onPick, align = 'start', minWidth = 140 }: MenuPanelProps) {
  return (
    <Floating anchor={anchor} onClose={onClose} align={align} minWidth={minWidth}>
      <div className="bg-elevated border border-bd rounded-md shadow-pop py-1">
        {items.map(it =>
          it.divider ? (
            <div key={it.key} className="my-1 border-t border-bd mx-2" />
          ) : (
            <div
              key={it.key}
              onClick={() => !it.disabled && onPick(it.key)}
              className={`mx-1 h-8 px-2.5 rounded-sm flex items-center gap-2.5 text-[13px] cursor-pointer transition-colors ${
                it.danger ? 'text-danger hover:bg-danger/10' : 'text-fg hover:bg-hover'
              } ${it.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {it.icon && <span className="shrink-0 text-dim [&>svg]:size-4">{it.icon}</span>}
              <span className="whitespace-nowrap">{it.label}</span>
            </div>
          ),
        )}
      </div>
    </Floating>
  )
}

interface DropdownProps {
  items: MenuItem[]
  onPick: (key: string) => void
  /** 触发器内容 */
  children: ReactNode
  align?: 'start' | 'end'
  className?: string
}

/** 下拉菜单：包裹触发元素，点击弹出菜单 */
export function Dropdown({ items, onPick, children, align = 'start', className = '' }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)

  return (
    <span
      ref={wrapRef}
      className={`inline-flex ${className}`}
      onClick={e => {
        e.stopPropagation()
        if (!wrapRef.current) return
        setAnchor(wrapRef.current.getBoundingClientRect())
        setOpen(o => !o)
      }}
    >
      {children}
      {open && anchor && (
        <MenuPanel
          anchor={anchor}
          items={items}
          align={align}
          onClose={() => setOpen(false)}
          onPick={key => {
            setOpen(false)
            onPick(key)
          }}
        />
      )}
    </span>
  )
}
