import { useSessionStore } from '../stores/sessionStore'
import { useConnStore } from '../stores/connStore'
import { useT } from '../i18n/I18nProvider'

/** 底部状态栏：SSH2 | 加密算法 | host:port | UTF-8 + 连接状态（参照设计图） */
export function StatusBar() {
  const t = useT()
  const activeTab = useSessionStore(s => s.tabs.find(x => x.id === s.activeTabId))
  const connSession = useSessionStore(s =>
    activeTab ? s.connSessions[activeTab.connectionId] : undefined,
  )
  const conn = useConnStore(s =>
    activeTab ? s.connections.find(c => c.id === activeTab.connectionId) : undefined,
  )

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
    </div>
  )
}
