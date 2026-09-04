import { useEffect, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useConnStore } from '../stores/connStore'
import { useT } from '../i18n/I18nProvider'
import { Tooltip } from '../components/ui'
import { useCheckUpdate } from '../components/UpdateDialog'
import { Cpu, HardDrive, MemoryStick, RefreshCw } from 'lucide-react'
import type { SysStats } from '../../electron/shared/types'

/** 格式化百分比为带颜色的状态条文字 */
function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode
  label: string
  value: number
  detail: string
}) {
  const color =
    value >= 90 ? 'text-danger' : value >= 70 ? 'text-warning' : 'text-accent'
  return (
    <Tooltip label={`${label}：${value}%\n${detail}`}>
      <span className="flex items-center gap-1">
        {icon}
        <span className={`mono ${color}`}>{value}%</span>
      </span>
    </Tooltip>
  )
}

/** 底部状态栏：SSH2 | 加密算法 | host:port | UTF-8 + 连接状态 + 远程资源占用 */
export function StatusBar() {
  const t = useT()
  const checkUpdate = useCheckUpdate()
  const activeTab = useSessionStore(s => s.tabs.find(x => x.id === s.activeTabId))
  const connSession = useSessionStore(s =>
    activeTab ? s.connSessions[activeTab.connectionId] : undefined,
  )
  const conn = useConnStore(s =>
    activeTab ? s.connections.find(c => c.id === activeTab.connectionId) : undefined,
  )

  const [stats, setStats] = useState<SysStats | null>(null)

  // 连接成功后每 5 秒轮询远程资源占用
  useEffect(() => {
    const sessionId = connSession?.sshSessionId
    if (connSession?.status !== 'connected' || !sessionId) {
      setStats(null)
      return
    }
    let cancelled = false
    let timer: NodeJS.Timeout
    const poll = async () => {
      try {
        const s = await window.api.sshStats(sessionId)
        if (!cancelled) setStats(s)
      } catch {
        // 静默失败，下次重试
      }
    }
    void poll()
    timer = setInterval(poll, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connSession?.status, connSession?.sshSessionId])

  return (
    <div className="flex items-center gap-4 px-3 h-[var(--statusbar-h)] bg-panel border-t border-bd text-[11px] text-dim shrink-0">
      {activeTab && conn ? (
        <>
          <span className="text-accent font-medium">{t('status.protocol')}</span>
          <span className="mono">{connSession?.info?.cipher || '—'}</span>
          <span className="mono">
            {conn.host}:{conn.port}
          </span>
          <span>{t('status.encoding')}</span>

          {/* 远程资源占用（仅连接成功后显示） */}
          {stats && (
            <>
              <div className="w-px h-3 bg-bd" />
              <Stat
                icon={<Cpu size={12} />}
                label={t('status.cpu')}
                value={stats.cpu}
                detail={t('status.cpu')}
              />
              <Stat
                icon={<MemoryStick size={12} />}
                label={t('status.mem')}
                value={stats.mem}
                detail={`${stats.memUsed} / ${stats.memTotal} MB`}
              />
              <Stat
                icon={<HardDrive size={12} />}
                label={t('status.disk')}
                value={stats.disk}
                detail={`${stats.diskUsed} / ${stats.diskTotal} GB`}
              />
            </>
          )}

          <div className="flex-1" />
          {connSession?.status === 'connecting' && (
            <span className="text-warning">{t('common.loading')}</span>
          )}
          {connSession?.status === 'connected' && (
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-accent" />
              {connSession.info?.username}@{conn.name}
            </span>
          )}
          {(connSession?.status === 'error' || connSession?.status === 'closed') && (
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-danger" />
              {t('term.connClosed')}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="text-accent font-medium">{t('status.protocol')}</span>
          <div className="flex-1" />
          <span>mssh</span>
        </>
      )}

      <Tooltip label={t('update.check')}>
        <button
          onClick={checkUpdate}
          className="flex items-center gap-1 text-dim hover:text-fg transition-colors mono"
        >
          <RefreshCw size={11} />
          v{__APP_VERSION__}
        </button>
      </Tooltip>
    </div>
  )
}
