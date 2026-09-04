import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { TransferStatus } from '../../../electron/shared/types'
import { useT } from '../../i18n/I18nProvider'
import { Progress, Tooltip } from '../../components/ui'
import { queueSummary, useTransferStore } from '../../stores/transferStore'
import { formatSize, formatSpeed } from '../../utils/files'

const STATUS_INFO: Record<TransferStatus, { key: 'sftp.pending' | 'sftp.active' | 'sftp.done' | 'sftp.failed' | 'sftp.cancelled'; cls: string }> = {
  pending: { key: 'sftp.pending', cls: 'text-dim' },
  active: { key: 'sftp.active', cls: 'text-accent' },
  done: { key: 'sftp.done', cls: 'text-info' },
  error: { key: 'sftp.failed', cls: 'text-danger' },
  cancelled: { key: 'sftp.cancelled', cls: 'text-faint' },
}

/** 底部传输队列面板 */
export function TransferPanel() {
  const t = useT()
  const items = useTransferStore(s => s.items)
  const expanded = useTransferStore(s => s.expanded)
  const setExpanded = useTransferStore(s => s.setExpanded)
  const clearFinished = useTransferStore(s => s.clearFinished)

  if (!items.length) return null

  const { activeCount, speed } = queueSummary(items)
  const finishedCount = items.length - activeCount

  return (
    <div className="border-t border-bd bg-bg shrink-0">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 h-8 px-3 text-xs cursor-pointer hover:bg-hover/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-dim" />
        ) : (
          <ChevronRight size={14} className="text-dim" />
        )}
        <span className="text-fg">{t('sftp.queue')}</span>
        {activeCount > 0 ? (
          <span className="text-accent">
            {t('sftp.active')} · {formatSpeed(speed)}
          </span>
        ) : (
          <span className="text-dim">{t('sftp.idle')}</span>
        )}
        <div className="flex-1" />
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

      {expanded && (
        <div className="max-h-52 overflow-y-auto border-t border-bd/60">
          {items.map(item => {
            const pct = item.size ? Math.round((item.transferred / item.size) * 100) : 0
            const info = STATUS_INFO[item.status]
            return (
              <div
                key={item.id}
                title={
                  item.error
                    ? `${item.error}\n${item.localPath} → ${item.remotePath}`
                    : `${item.localPath} → ${item.remotePath}`
                }
                className="grid grid-cols-[18px_minmax(0,1fr)_110px_110px_70px_52px] gap-2 items-center h-9 px-3 text-xs hover:bg-hover/40 transition-colors"
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
