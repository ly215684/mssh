import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../../stores/appStore'
import type { ThemeMode } from '../../../electron/shared/types'
import { Clipboard, Copy } from 'lucide-react'
import { useCtxStore } from '../../components/ui/ContextMenu'

/** 终端 ANSI 配色（与主题令牌一致的绿色系） */
function buildTheme(mode: ThemeMode): ITheme {
  if (mode === 'light') {
    return {
      background: '#ffffff',
      foreground: '#24312a',
      cursor: '#16a34a',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(22, 163, 74, 0.25)',
      black: '#24312a',
      red: '#dc2626',
      green: '#16a34a',
      yellow: '#ca8a04',
      blue: '#0284c7',
      magenta: '#9333ea',
      cyan: '#0d9488',
      white: '#d7e0d8',
      brightBlack: '#77857a',
      brightRed: '#ef4444',
      brightGreen: '#22c55e',
      brightYellow: '#eab308',
      brightBlue: '#38bdf8',
      brightMagenta: '#a855f7',
      brightCyan: '#14b8a6',
      brightWhite: '#ffffff',
    }
  }
  return {
    background: '#0a0e0b',
    foreground: '#c9d6ca',
    cursor: '#22c55e',
    cursorAccent: '#0a0e0b',
    selectionBackground: 'rgba(34, 197, 94, 0.3)',
    black: '#1c231c',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#38bdf8',
    magenta: '#c084fc',
    cyan: '#2dd4bf',
    white: '#d9e4da',
    brightBlack: '#55645b',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#7dd3fc',
    brightMagenta: '#d8b4fe',
    brightCyan: '#5eead4',
    brightWhite: '#f0f7f0',
  }
}

interface TermProps {
  /** SSH 会话 id；变化时重建终端（重连场景） */
  sessionId: string
}

/** xterm.js 封装：数据流、自适应、主题/设置热更新、右键复制粘贴 */
export function Term({ sessionId }: TermProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const theme = useAppStore(s => s.settings.theme)
  const ts = useAppStore(s => s.settings.terminal)

  // 创建终端 + 订阅数据流
  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: ts.fontFamily,
      fontSize: ts.fontSize,
      cursorStyle: ts.cursorStyle,
      cursorBlink: ts.cursorBlink,
      scrollback: ts.scrollback,
      theme: buildTheme(theme),
    })
    termRef.current = term

    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    fit.fit()

    const offData = window.api.onSshData(sessionId, d => term.write(d))
    const dataSub = term.onData(d => window.api.sshWrite(sessionId, d))
    const resizeSub = term.onResize(({ cols, rows }) => window.api.sshResize(sessionId, cols, rows))
    window.api.sshResize(sessionId, term.cols, term.rows)

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
    })
    ro.observe(el)
    term.focus()

    // 右键菜单：复制选中 / 粘贴剪贴板
    const onContextMenu = async (e: MouseEvent) => {
      e.preventDefault()
      const hasSelection = term.hasSelection()
      const items = [
        ...(hasSelection
          ? [{ key: 'copy', label: '复制', icon: <Copy size={14} /> }]
          : []),
        { key: 'paste', label: '粘贴', icon: <Clipboard size={14} /> },
      ]
      useCtxStore.getState().open({
        x: e.clientX,
        y: e.clientY,
        items,
        onPick: async (key: string) => {
          if (key === 'copy' && hasSelection) {
            await window.api.clipboardWriteText(term.getSelection())
            term.clearSelection()
          } else if (key === 'paste') {
            const text = await window.api.clipboardReadText()
            if (text) window.api.sshWrite(sessionId, text)
          }
        },
      })
    }
    el.addEventListener('contextmenu', onContextMenu)

    return () => {
      el.removeEventListener('contextmenu', onContextMenu)
      offData()
      dataSub.dispose()
      resizeSub.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 设置/主题热更新（不销毁终端）
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = ts.fontFamily
    term.options.fontSize = ts.fontSize
    term.options.cursorStyle = ts.cursorStyle
    term.options.cursorBlink = ts.cursorBlink
    term.options.scrollback = ts.scrollback
    term.options.theme = buildTheme(theme)
    fitRef.current?.fit()
  }, [theme, ts])

  return <div ref={hostRef} className="absolute inset-0 p-1.5" />
}
