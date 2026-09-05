import { useEffect } from 'react'
import { SquareTerminal, Plus } from 'lucide-react'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { StatusBar } from './StatusBar'
import { useSessionStore } from '../stores/sessionStore'
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n/I18nProvider'
import { TerminalView } from '../pages/terminal/TerminalView'
import { SftpView } from '../pages/sftp/SftpView'
import { DockerView } from '../pages/docker/DockerView'
import { CronView } from '../pages/cron/CronView'
import { Button } from '../components/ui'

/** 全局快捷键：Ctrl+Tab 切换标签 / Ctrl+W 关闭标签 / Ctrl+N 新建连接 / Ctrl+, 设置 */
function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      // 焦点在终端内时不拦截（Ctrl+W 等需透传给 shell）
      const el = e.target as HTMLElement | null
      if (el && el.closest('.xterm')) return

      const { tabs, activeTabId, setActive, closeTab } = useSessionStore.getState()
      const ui = useUiStore.getState()

      if (e.key === 'Tab') {
        e.preventDefault()
        if (tabs.length > 1) {
          const idx = tabs.findIndex(t => t.id === activeTabId)
          const next = e.shiftKey
            ? (idx - 1 + tabs.length) % tabs.length
            : (idx + 1) % tabs.length
          setActive(tabs[next].id)
        }
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault()
        if (activeTabId) closeTab(activeTabId)
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        ui.openNewConn()
      } else if (e.key === ',') {
        e.preventDefault()
        ui.setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** 主界面骨架：标题栏 + [侧栏 | 标签栏 + 内容 + 状态栏] */
export function MainLayout() {
  useHotkeys()
  const activeTab = useSessionStore(s => s.tabs.find(x => x.id === s.activeTabId))
  const openNewConn = useUiStore(s => s.openNewConn)
  const setQuickConnOpen = useUiStore(s => s.setQuickConnOpen)

  return (
    <div className="flex flex-col h-screen bg-bg text-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex flex-col flex-1 min-w-0">
          <TabBar />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {activeTab ? (
              activeTab.type === 'terminal' ? (
                <TerminalView key={activeTab.id} tab={activeTab} />
              ) : activeTab.type === 'docker' ? (
                <DockerView key={activeTab.id} tab={activeTab} />
              ) : activeTab.type === 'cron' ? (
                <CronView key={activeTab.id} tab={activeTab} />
              ) : (
                <SftpView key={activeTab.id} tab={activeTab} />
              )
            ) : (
              <Welcome onQuick={() => setQuickConnOpen(true)} onNew={() => openNewConn()} />
            )}
          </div>
          <StatusBar />
        </main>
      </div>
    </div>
  )
}

/** 无标签时的欢迎页 */
function Welcome({ onQuick, onNew }: { onQuick: () => void; onNew: () => void }) {
  const t = useT()
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-dim">
      <span className="size-14 rounded-2xl bg-accent-dim text-accent flex items-center justify-center">
        <SquareTerminal size={30} />
      </span>
      <div className="text-lg font-medium text-fg">mssh</div>
      <div className="text-xs text-faint">{t('quick.hint')}</div>
      <div className="flex gap-2.5 mt-1">
        <Button variant="primary" icon={<Plus size={14} />} onClick={onQuick}>
          {t('sidebar.quickConnect')}
        </Button>
        <Button onClick={onNew}>{t('sidebar.newConnection')}</Button>
      </div>
    </div>
  )
}
