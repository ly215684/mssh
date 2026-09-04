import { Check, Loader2, Minus } from 'lucide-react'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** 半选状态 */
  indeterminate?: boolean
  disabled?: boolean
  className?: string
}

/** 全局复选框 */
export function Checkbox({ checked, onChange, indeterminate, disabled, className = '' }: CheckboxProps) {
  const active = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      disabled={disabled}
      onClick={e => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={`size-4 rounded-sm border flex items-center justify-center shrink-0 transition-colors disabled:opacity-40 ${
        active ? 'bg-accent border-accent' : 'bg-input border-bd-strong hover:border-accent'
      } ${className}`}
    >
      {indeterminate ? (
        <Minus size={12} className="text-accent-contrast" />
      ) : checked ? (
        <Check size={12} className="text-accent-contrast" strokeWidth={3} />
      ) : null}
    </button>
  )
}

/** 全局加载指示器 */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin text-dim shrink-0 ${className}`} />
}
