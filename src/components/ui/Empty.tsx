import type { ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'

interface EmptyProps {
  icon?: ReactNode
  text?: string
  className?: string
}

/** 全局空态组件 */
export function Empty({ icon, text, className = '' }: EmptyProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2.5 py-12 text-faint ${className}`}>
      <div className="opacity-50">{icon ?? <FolderOpen size={30} strokeWidth={1.5} />}</div>
      {text && <div className="text-xs">{text}</div>}
    </div>
  )
}
