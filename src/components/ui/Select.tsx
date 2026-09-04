import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Floating } from './Floating'

export interface SelectOption {
  label: ReactNode
  value: string
  disabled?: boolean
}

interface SelectProps {
  value?: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
}

/** 全局下拉选择器 */
export function Select({ value, onChange, options, placeholder, className = '', disabled }: SelectProps) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = options.find(o => o.value === value)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={e => {
          e.stopPropagation()
          setOpen(o => !o)
        }}
        className={`w-full h-8.5 px-3 bg-input border rounded-md flex items-center justify-between gap-2 text-[13px] transition-colors disabled:opacity-50 ${
          open ? 'border-accent' : 'border-bd hover:border-bd-strong'
        } ${className}`}
      >
        <span className={`truncate ${current ? 'text-fg' : 'text-faint'}`}>{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown size={14} className={`text-dim shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && btnRef.current && (
        <Floating anchor={btnRef.current.getBoundingClientRect()} onClose={() => setOpen(false)}>
          <div className="bg-elevated border border-bd rounded-md shadow-pop py-1 max-h-64 overflow-auto">
            {options.map(o => (
              <div
                key={o.value}
                onClick={() => {
                  if (o.disabled) return
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`mx-1 h-8 px-2.5 rounded-sm flex items-center text-[13px] cursor-pointer transition-colors ${
                  o.value === value ? 'text-accent bg-accent-dim' : 'text-fg hover:bg-hover'
                } ${o.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {o.label}
              </div>
            ))}
          </div>
        </Floating>
      )}
    </>
  )
}
