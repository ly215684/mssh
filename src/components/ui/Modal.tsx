import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** 是否显示右上角关闭按钮 */
  closable?: boolean
  /** 点击遮罩是否关闭 */
  maskClosable?: boolean
}

/** 全局弹窗组件（参照设计图：标题 + 右上角方形关闭钮 + 底部分隔线按钮区） */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
  closable = true,
  maskClosable = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/50 animate-overlay-in"
      onMouseDown={() => maskClosable && onClose()}
    >
      <div
        style={{ width }}
        className="flex flex-col max-h-[85vh] bg-elevated border border-bd rounded-lg shadow-modal animate-modal-in"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pl-5 pr-3 pt-3.5 pb-2 shrink-0">
          <div className="text-[15px] font-medium text-fg">{title}</div>
          {closable && (
            <button
              onClick={onClose}
              className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="px-5 pb-5 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2.5 px-5 py-4 border-t border-bd shrink-0">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}
