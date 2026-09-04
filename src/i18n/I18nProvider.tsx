import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { Language } from '../../electron/shared/types'
import { useAppStore } from '../stores/appStore'
import zhCN, { type DictKey } from './zh-CN'
import enUS from './en-US'

const DICTS: Record<Language, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

type TFn = (key: DictKey, params?: Record<string, string | number>) => string

interface I18nContextValue {
  t: TFn
  lang: Language
}

const I18nContext = createContext<I18nContextValue>({ t: k => k, lang: 'zh-CN' })

/** 供非组件环境（store 等）使用的全局翻译函数 */
let globalT: TFn = (k, params) => {
  let str = DICTS['zh-CN'][k] ?? k
  if (params) {
    for (const [k2, v] of Object.entries(params)) {
      str = str.split(`{${k2}}`).join(String(v))
    }
  }
  return str
}

export function getGlobalT(): TFn {
  return globalT
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useAppStore(s => s.settings.language)

  const t = useCallback<TFn>(
    (key, params) => {
      let str = DICTS[lang]?.[key] ?? DICTS['zh-CN'][key] ?? key
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          str = str.split(`{${k}}`).join(String(v))
        }
      }
      return str
    },
    [lang],
  )

  const value = useMemo(() => ({ t, lang }), [t, lang])

  globalT = t

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** 获取翻译函数 */
export function useT(): TFn {
  return useContext(I18nContext).t
}
