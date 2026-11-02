import { Power } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  DEFAULT_TOOLBAR_ITEMS,
  type SessionTab,
  type ToolbarItemId,
} from '../../../electron/shared/types'
import { useAppStore } from '../../stores/appStore'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore, SSH_RETRY_MAX_ATTEMPTS } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import { Term } from './Terminal'
import { TOOLBAR_META } from './toolbarMeta'
import { Spinner, Tooltip } from '../../components/ui'

/** Telnet 连接不支持的工具栏按钮 */
const TELNET_HIDDEN = new Set<ToolbarItemId>(['docker', 'cron', 'monitor', 'system', 'sftp'])

const BTN_CLASS =
  'size-7 flex items-center justify-center rounded-md transition-colors'

/** 终端标签页：连接信息工具行 + xterm 终端 + 断线重连（参照设计图） */
export function TerminalView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const connSession = useSessionStore(s => s.connSessions[tab.connectionId])
  const reconnect = useSessionStore(s => s.reconnect)
  const stopRetry = useSessionStore(s => s.stopRetry)
  const openSftp = useSessionStore(s => s.openSftp)
  const openDocker = useSessionStore(s => s.openDocker)
  const openCron = useSessionStore(s => s.openCron)
  const openMonitor = useSessionStore(s => s.openMonitor)
  const openSystem = useSessionStore(s => s.openSystem)
  const disconnect = useSessionStore(s => s.disconnect)
  const aiPanelOpen = useUiStore(s => s.aiPanelOpen)
  const toggleAiPanel = useUiStore(s => s.toggleAiPanel)
  const toolbarItems = useAppStore(s => s.settings.toolbar?.items) ?? DEFAULT_TOOLBAR_ITEMS

  if (!conn) return null

  const status = connSession?.status
  const sessionId = connSession?.sshSessionId ?? null
  const isTelnet = conn.protocol === 'telnet'

  /** 可配置按钮的动作表 */
  const actions: Record<
    ToolbarItemId,
    { label: string; icon: ReactNode; className: string; onClick: () => void }
  > = {
    ai: {
      label: t('term.ai'),
      icon: <TOOLBAR_META.ai.icon size={15} />,
      className: aiPanelOpen ? 'bg-accent-dim text-accent' : '',
      onClick: () => toggleAiPanel(),
    },
    docker: {
      label: t('term.docker'),
      icon: <TOOLBAR_META.docker.icon size={15} />,
      className: '',
      onClick: () => openDocker(tab.connectionId),
    },
    cron: {
      label: t('term.cron'),
      icon: <TOOLBAR_META.cron.icon size={15} />,
      className: '',
      onClick: () => openCron(tab.connectionId),
    },
    monitor: {
      label: t('term.monitor'),
      icon: <TOOLBAR_META.monitor.icon size={15} />,
      className: '',
      onClick: () => openMonitor(tab.connectionId),
    },
    system: {
      label: t('term.system'),
      icon: <TOOLBAR_META.system.icon size={15} />,
      className: '',
      onClick: () => openSystem(tab.connectionId),
    },
    sftp: {
      label: t('term.transfer'),
      icon: <TOOLBAR_META.sftp.icon size={15} />,
      className: '',
      onClick: () => openSftp(tab.connectionId),
    },
  }

  const visibleItems = toolbarItems.filter(
    it => it.enabled && (!isTelnet || !TELNET_HIDDEN.has(it.id)),
  )

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <span className="text-xs text-dim mono">
          {conn.username && (
            <>
              <span className="text-accent">{conn.username}@</span>
            </>
          )}
          <span className={conn.username ? '' : 'text-accent'}>{conn.host}</span>:{conn.port}
        </span>
        <div className="flex-1" />
        {visibleItems.map(it => {
          const action = actions[it.id]
          return (
            <Tooltip key={it.id} placement="bottom" label={action.label}>
              <button
                onClick={action.onClick}
                className={`${BTN_CLASS} text-dim hover:text-accent hover:bg-accent-dim ${action.className}`}
              >
                {action.icon}
              </button>
            </Tooltip>
          )
        })}
        <Tooltip placement="bottom" label={t('term.disconnect')}>
          <button
            onClick={() => disconnect(tab.connectionId)}
            className={`${BTN_CLASS} text-dim hover:text-danger hover:bg-danger/10`}
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
              {connSession?.retryAttempt !== undefined
                ? t('term.autoRetrying', {
                    n: connSession.retryAttempt,
                    max: SSH_RETRY_MAX_ATTEMPTS,
                  })
                : t('term.connecting', { target: `${conn.host}:${conn.port}` })}
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
            {connSession?.retryAttempt !== undefined ? (
              <>
                <div className="text-xs text-dim">
                  {t('term.autoRetrying', {
                    n: connSession.retryAttempt,
                    max: SSH_RETRY_MAX_ATTEMPTS,
                  })}
                </div>
                <button
                  onClick={() => stopRetry(tab.connectionId)}
                  className="mt-1 text-xs text-dim hover:text-fg hover:underline"
                >
                  {t('term.stopRetry')}
                </button>
              </>
            ) : (
              <button
                onClick={() => reconnect(tab.connectionId)}
                className="mt-1 text-xs text-accent hover:underline"
              >
                {t('term.reconnect')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
