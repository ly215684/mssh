import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react'

export type MessageType = 'success' | 'error' | 'warning' | 'info'

interface MsgItem {
  id: number
  type: MessageType
  content: string
}

let seq = 0
let items: MsgItem[] = []
const subs = new Set<(items: MsgItem[]) => void>()

function emit() {
  subs.forEach(f => f(items))
}

function push(type: MessageType, content: string) {
  const id = ++seq
  items = [...items, { id, type, content }]
  emit()
  window.setTimeout(() => {
    items = items.filter(m => m.id !== id)
    emit()
  }, 3000)
}

/** 全局消息提示（命令式 API） */
export const message = {
  success: (content: string) => push('success', content),
  error: (content: string) => push('error', content),
  warning: (content: string) => push('warning', content),
  info: (content: string) => push('info', content),
}

const ICONS: Record<MessageType, LucideIcon> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const COLORS: Record<MessageType, string> = {
  success: 'text-accent',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
}

/** 消息宿主组件，挂载于 App 根部 */
export function MessageHost() {
  const [list, setList] = useState<MsgItem[]>([])

  useEffect(() => {
    const fn = (i: MsgItem[]) => setList([...i])
    subs.add(fn)
    return () => {
      subs.delete(fn)
    }
  }, [])

  return createPortal(
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[900] flex flex-col items-center gap-2 pointer-events-none">
      {list.map(m => {
        const Icon = ICONS[m.type]
        return (
          <div
            key={m.id}
            className="animate-msg-in pointer-events-auto flex items-center gap-2 bg-elevated border border-bd shadow-pop rounded-md px-3.5 h-9 text-[13px] text-fg"
          >
            <Icon size={15} className={COLORS[m.type]} />
            <span>{m.content}</span>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
