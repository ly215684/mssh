import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, X } from 'lucide-react'
import type { TransferStatus } from '../../../electron/shared/types'
import { useT } from '../../i18n/I18nProvider'
import { Progress, Tooltip } from '../../components/ui'
import { queueSummary, cancelTransfer, useTransferStore } from '../../stores/transferStore'
import { formatSize, formatSpeed } from '../../utils/files'

const STATUS_INFO: Record<TransferStatus, { key: 'sftp.pending' | 'sftp.active' | 'sftp.done' | 'sftp.failed' | 'sftp.cancelled'; cls: string }> = {
  pending: { key: 'sftp.pending', cls: 'text-dim' },
  active: { key: 'sftp.active', cls: 'text-accent' },
  done: { key: 'sftp.done', cls: 'text-info' },
  error: { key: 'sftp.failed', cls: 'text-danger' },
  cancelled: { key: 'sftp.cancelled', cls: 'text-faint' },
}

/** 底部传输队列条：点击向上弹出传输进度列表 */
export function TransferPanel() {
  const t = useT()
  const items = useTransferStore(s => s.items)
  const expanded = useTransferStore(s => s.expanded)
  const setExpanded = useTransferStore(s => s.setExpanded)
  const clearFinished = useTransferStore(s => s.clearFinished)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击面板外部关闭弹出列表
  useEffect(() => {
    if (!expanded) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [expanded, setExpanded])

  if (!items.length) return null

  const { activeCount, speed } = queueSummary(items)
  const finishedCount = items.length - activeCount
  const activeItems = items.filter(i => i.status === 'active' || i.status === 'pending')
  const totalBytes = activeItems.reduce((a, i) => a + i.size, 0)
  const doneBytes = activeItems.reduce((a, i) => a + i.transferred, 0)
  const overallPct = totalBytes ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0

  return (
    <div ref={rootRef} className="relative border-t border-bd bg-bg shrink-0">
      {/* 弹出的传输进度列表 */}
      {expanded && (
        <div className="absolute bottom-full left-0 right-0 z-30 max-h-64 overflow-y-auto border-t border-bd bg-bg shadow-lg shadow-black/20">
          {items.map(item => {
            const pct = item.size ? Math.round((item.transferred / item.size) * 100) : 0
            const info = STATUS_INFO[item.status]
            const running = item.status === 'active' || item.status === 'pending'
            return (
              <div
                key={item.id}
                title={
                  item.error
                    ? `${item.error}\n${item.localPath} → ${item.remotePath}`
                    : `${item.localPath} → ${item.remotePath}`
                }
                className="grid grid-cols-[18px_minmax(0,1fr)_110px_110px_70px_52px_20px] gap-2 items-center h-9 px-3 text-xs hover:bg-hover/40 transition-colors"
              >
                {item.direction === 'upload' ? (
                  <ArrowUp size={13} className="text-accent" />
                ) : (
                  <ArrowDown size={13} className="text-info" />
                )}
                <span className="truncate text-fg">{item.name}</span>
                <span className="min-w-0" title={`${pct}%`}>
                  <Progress value={pct} />
                </span>
                <span className="text-right text-dim" title={`${pct}%`}>
                  {formatSize(item.transferred)}/{formatSize(item.size)}
                </span>
                <span className="text-right text-dim">
                  {item.status === 'active' ? formatSpeed(item.speed) : ''}
                </span>
                <span className={`text-right ${info.cls}`}>{t(info.key)}</span>
                <span>
                  {running && (
                    <Tooltip label={t('sftp.cancel')}>
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          cancelTransfer(item.id)
                        }}
                        className="size-5 flex items-center justify-center rounded text-dim hover:text-danger hover:bg-hover transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </Tooltip>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 底部状态条 */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 h-8 px-3 text-xs cursor-pointer hover:bg-hover/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-dim" />
        ) : (
          <ChevronUp size={14} className="text-dim" />
        )}
        <span className="text-fg shrink-0">{t('sftp.queue')}</span>
        {activeCount > 0 ? (
          <span className="text-accent shrink-0">
            {t('sftp.active')} · {formatSpeed(speed)}
          </span>
        ) : (
          <span className="text-dim">{t('sftp.idle')}</span>
        )}
        {activeCount > 0 && (
          <span className="flex-1 min-w-0 mx-1" title={`${overallPct}%`}>
            <Progress value={overallPct} />
          </span>
        )}
        <div className={activeCount > 0 ? 'shrink-0' : 'flex-1'} />
        {activeCount > 0 && (
          <span className="text-dim mono shrink-0">{overallPct}%</span>
        )}
        {finishedCount > 0 && (
          <Tooltip label={t('sftp.clearFinished')}>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                clearFinished()
              }}
              className="size-6 flex items-center justify-center rounded text-dim hover:text-fg hover:bg-hover transition-colors"
            >
              <X size={13} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
