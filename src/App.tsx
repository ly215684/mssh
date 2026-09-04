import { useEffect, useState } from 'react'
import { ThemeProvider } from './theme/ThemeProvider'
import { I18nProvider } from './i18n/I18nProvider'
import { MainLayout } from './layouts/MainLayout'
import { NewConnectionModal } from './pages/connect/NewConnectionModal'
import { QuickConnectModal } from './pages/connect/QuickConnectModal'
import { SettingsModal } from './pages/settings/SettingsModal'
import { useAppStore } from './stores/appStore'
import { useConnStore } from './stores/connStore'
import { useSessionStore } from './stores/sessionStore'
import { startTransferListener } from './stores/transferStore'
import { ConfirmHost, ContextMenuHost, MessageHost } from './components/ui'

let booted = false

export default function App() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (booted) return
    booted = true

    void (async () => {
      const cfg = await window.api.getConfig()
      // 主题需在首次渲染前应用，避免闪烁
      document.documentElement.dataset.theme = cfg.settings.theme
      useAppStore.getState().hydrate(cfg.settings, cfg.dataDir)
      useConnStore.getState().hydrate(cfg.connections, cfg.groups)
      startTransferListener()
      if (cfg.settings.restoreSession && cfg.layout && cfg.layout.tabs.length > 0) {
        await useSessionStore.getState().restore(cfg.layout.tabs, cfg.layout.activeTabId)
      }
      setReady(true)
    })()
  }, [])

  if (!ready) return null

  return (
    <ThemeProvider>
      <I18nProvider>
        <MainLayout />
        <NewConnectionModal />
        <QuickConnectModal />
        <SettingsModal />
        <MessageHost />
        <ConfirmHost />
        <ContextMenuHost />
      </I18nProvider>
    </ThemeProvider>
  )
}
