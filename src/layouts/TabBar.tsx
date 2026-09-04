import { Folder, Plus, SquareTerminal, X } from 'lucide-react'
import { useSessionStore } from '../stores/sessionStore'
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n/I18nProvider'
import { Tooltip } from '../components/ui'

/** 会话标签栏（终端 / SFTP 两类标签，参照设计图） */
export function TabBar() {
  const t = useT()
  const tabs = useSessionStore(s => s.tabs)
  const activeTabId = useSessionStore(s => s.activeTabId)
  const setActive = useSessionStore(s => s.setActive)
  const closeTab = useSessionStore(s => s.closeTab)
  const openNewConn = useUiStore(s => s.openNewConn)

  return (
    <div className="flex items-end gap-1 px-2 pt-1.5 h-[var(--tabbar-h)] bg-bg border-b border-bd shrink-0">
      {tabs.map(tab => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`group flex items-center gap-1.5 h-full px-3 rounded-t-md border border-b-0 text-xs cursor-pointer transition-colors ${
              active
                ? 'bg-elevated text-fg border-bd'
                : 'bg-transparent text-dim border-transparent hover:bg-hover hover:text-fg'
            }`}
          >
            {tab.type === 'terminal' ? (
              <SquareTerminal size={13} className="shrink-0" />
            ) : (
              <Folder size={13} className="shrink-0" />
            )}
            <span className="max-w-[130px] truncate">{tab.title}</span>
            <button
              onClick={e => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="opacity-0 group-hover:opacity-100 text-dim hover:text-danger transition-opacity"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}

      <Tooltip label={t('sidebar.newConnection')}>
        <button
          onClick={openNewConn}
          className="mb-1 ml-0.5 size-6 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
        >
          <Plus size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
