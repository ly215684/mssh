import { Minus, Square, X } from 'lucide-react'
import { useSessionStore } from '../stores/sessionStore'
import { useConnStore } from '../stores/connStore'

/** 自定义标题栏（无边框窗口：拖拽区 + 窗口控制按钮） */
export function TitleBar() {
  const activeTab = useSessionStore(s => s.tabs.find(t => t.id === s.activeTabId))
  const conn = useConnStore(s =>
    activeTab ? s.connections.find(c => c.id === activeTab.connectionId) : undefined,
  )

  const title = activeTab
    ? `mssh — ${activeTab.title}${conn ? ` (${conn.username})` : ''}`
    : 'mssh'

  return (
    <div
      className="app-drag flex items-center h-[var(--titlebar-h)] pl-3 bg-bg border-b border-bd shrink-0 select-none"
    >
      <div className="text-xs text-dim truncate">{title}</div>
      <div className="flex-1" />
      {window.api.platform !== 'darwin' && (
        <div className="app-no-drag flex items-stretch h-full">
          <button
            onClick={() => window.api.win.minimize()}
            className="w-11 flex items-center justify-center text-dim hover:bg-hover hover:text-fg transition-colors"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={() => window.api.win.maximize()}
            className="w-11 flex items-center justify-center text-dim hover:bg-hover hover:text-fg transition-colors"
          >
            <Square size={11} />
          </button>
          <button
            onClick={() => window.api.win.close()}
            className="w-11 flex items-center justify-center text-dim hover:bg-danger hover:text-white transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
