import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

/** 将主题令牌挂载到 html[data-theme]，令牌体系见 styles/tokens.css */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useAppStore(s => s.settings.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return <>{children}</>
}
