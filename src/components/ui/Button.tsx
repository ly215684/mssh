import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Loader2 } from 'lucide-react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

const variantCls: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-contrast hover:bg-accent-hover active:brightness-95 font-medium',
  secondary:
    'bg-elevated border border-bd text-fg hover:border-bd-strong hover:bg-hover active:bg-active',
  ghost: 'text-dim hover:text-fg hover:bg-hover',
  danger: 'bg-danger text-white hover:brightness-110',
}

const sizeCls: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1 rounded-md',
  md: 'h-8.5 px-4 text-[13px] gap-1.5 rounded-md',
}

/** 全局按钮组件 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variantCls[variant]} ${sizeCls[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
})
