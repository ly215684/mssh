import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'suffix'> {
  prefix?: ReactNode
  suffix?: ReactNode
}

const baseCls =
  'w-full h-8.5 bg-input border border-bd rounded-md px-3 text-[13px] text-fg placeholder:text-faint ' +
  'transition-colors focus:border-accent hover:border-bd-strong disabled:opacity-50'

/** 全局输入框 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', prefix, suffix, ...rest },
  ref,
) {
  if (prefix || suffix) {
    return (
      <div
        className={`flex items-center bg-input border border-bd rounded-md focus-within:border-accent hover:border-bd-strong transition-colors ${className}`}
      >
        {prefix && <span className="pl-3 text-dim shrink-0">{prefix}</span>}
        <input ref={ref} className="flex-1 bg-transparent px-2.5 h-8.5 text-[13px] text-fg placeholder:text-faint outline-none min-w-0" {...rest} />
        {suffix && <span className="pr-2.5 text-dim shrink-0">{suffix}</span>}
      </div>
    )
  }
  return <input ref={ref} className={`${baseCls} ${className}`} {...rest} />
})

/** 密码输入框（带可见性切换，参照设计图眼睛图标） */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'prefix' | 'suffix'>>(
  function PasswordInput({ className = '', ...rest }, ref) {
    const [visible, setVisible] = useState(false)
    return (
      <div
        className={`flex items-center bg-input border border-bd rounded-md focus-within:border-accent hover:border-bd-strong transition-colors ${className}`}
      >
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className="flex-1 bg-transparent px-3 h-8.5 text-[13px] text-fg placeholder:text-faint outline-none min-w-0"
          {...rest}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible(v => !v)}
          className="px-2.5 text-dim hover:text-fg shrink-0"
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    )
  },
)
