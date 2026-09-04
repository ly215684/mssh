import type { RendererApi } from '../../electron/shared/api'

declare global {
  /** 由 vite.config define 注入的应用版本号 */
  const __APP_VERSION__: string

  interface Window {
    api: RendererApi
  }
}

export {}
