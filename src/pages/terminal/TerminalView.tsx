import { useEffect } from 'react'
import { CalendarClock, Container, Download, Power, Upload } from 'lucide-react'
import type { SessionTab } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useT } from '../../i18n/I18nProvider'
import { Term } from './Terminal'
import { Spinner, Tooltip } from '../../components/ui'

/** 终端标签页：连接信息工具行 + xterm 终端 + 断线重连（参照设计图） */
export function TerminalView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const connSession = useSessionStore(s => s.connSessions[tab.connectionId])
  const markClosed = useSessionStore(s => s.markClosed)
  const reconnect = useSessionStore(s => s.reconnect)
  const openSftp = useSessionStore(s => s.openSftp)
  const openDocker = useSessionStore(s => s.openDocker)
  const openCron = useSessionStore(s => s.openCron)
  const disconnect = useSessionStore(s => s.disconnect)

  // SSH 会话退出事件 → 更新状态
  useEffect(() => {
    if (!connSession?.sshSessionId) return
    const sessionId = connSession.sshSessionId
    const off = window.api.onSshExit(sessionId, () => markClosed(tab.connectionId))
    return off
  }, [connSession?.sshSessionId, tab.connectionId, markClosed])

  if (!conn) return null

  const status = connSession?.status
  const sessionId = connSession?.sshSessionId ?? null

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <span className="text-xs text-dim mono">
          <span className="text-accent">
            {conn.username}@{conn.host}
          </span>
          :{conn.port}
        </span>
        <div className="flex-1" />
        <Tooltip label={t('term.docker')}>
          <button
            onClick={() => openDocker(tab.connectionId)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-accent hover:bg-accent-dim transition-colors"
          >
            <Container size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('term.cron')}>
          <button
            onClick={() => openCron(tab.connectionId)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-accent hover:bg-accent-dim transition-colors"
          >
            <CalendarClock size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('term.upload')}>
          <button
            onClick={() => openSftp(tab.connectionId)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <Upload size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('term.download')}>
          <button
            onClick={() => openSftp(tab.connectionId)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <Download size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('term.disconnect')}>
          <button
            onClick={() => disconnect(tab.connectionId)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-danger hover:bg-danger/10 transition-colors"
          >
            <Power size={15} />
          </button>
        </Tooltip>
      </div>

      {/* 终端区域 */}
      <div className="flex-1 relative min-h-0">
        {status === 'connecting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-dim">
            <Spinner size={22} />
            <div className="text-xs">
              {t('term.connecting', { target: `${conn.host}:${conn.port}` })}
            </div>
          </div>
        )}

        {sessionId && status === 'connected' && <Term key={sessionId} sessionId={sessionId} />}

        {(status === 'error' || status === 'closed') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="text-sm text-danger">{t('term.connClosed')}</div>
            {connSession?.error && (
              <div className="text-xs text-faint max-w-md text-center break-all selectable">
                {connSession.error}
              </div>
            )}
            <button
              onClick={() => reconnect(tab.connectionId)}
              className="mt-1 text-xs text-accent hover:underline"
            >
              {t('term.reconnect')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
