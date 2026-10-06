import { useEffect, useRef, useState } from 'react'
import { Monitor, Keyboard, Power, Maximize2, Eye, EyeOff } from 'lucide-react'
import RFB from '@novnc/novnc'
import type { SessionTab } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore, SSH_RETRY_MAX_ATTEMPTS } from '../../stores/sessionStore'
import { useT } from '../../i18n/I18nProvider'
import { Spinner, Tooltip } from '../../components/ui'

/** VNC 远程桌面标签页：主进程 WS→TCP 桥 + noVNC RFB 客户端 */
export function VncView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const connSession = useSessionStore(s => s.connSessions[tab.connectionId])
  const disconnect = useSessionStore(s => s.disconnect)
  const reconnect = useSessionStore(s => s.reconnect)
  const stopRetry = useSessionStore(s => s.stopRetry)

  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const [desktopName, setDesktopName] = useState('')
  const [scale, setScale] = useState(true)
  const [viewOnly, setViewOnly] = useState(false)

  const status = connSession?.status
  const sessionId = connSession?.sshSessionId ?? null
  const wsUrl = connSession?.info?.wsUrl ?? null

  // 挂载/重建 RFB（noVNC 内部自带 ResizeObserver，容器尺寸变化自动重缩放）
  useEffect(() => {
    if (status !== 'connected' || !wsUrl || !containerRef.current) return

    const rfb = new RFB(containerRef.current, wsUrl, {
      credentials: { password: conn?.password ?? '' },
    })
    rfb.scaleViewport = scale
    rfb.viewOnly = viewOnly
    rfb.background = '#000'
    rfb.focusOnClick = true
    rfbRef.current = rfb

    rfb.addEventListener('credentialsrequired', () => {
      rfb.sendCredentials({ password: conn?.password ?? '' })
    })
    rfb.addEventListener('desktopname', e => {
      setDesktopName(e.detail.name)
    })
    rfb.addEventListener('clipboard', e => {
      if (e.detail.text) window.api.clipboardWriteText(e.detail.text)
    })
    // noVNC 断开（服务器拒绝认证/主动关闭等）→ 通知主进程回收桥，
    // 由 ssh:exit → markClosed 统一驱动断线页，避免双写状态
    rfb.addEventListener('disconnect', () => {
      if (sessionId) void window.api.sshDisconnect(sessionId)
    })

    return () => {
      rfbRef.current = null
      rfb.disconnect()
    }
    // scale/viewOnly 由下方独立 effect 同步，不触发 RFB 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, wsUrl, sessionId])

  // 工具栏开关同步到 RFB 实例
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.scaleViewport = scale
  }, [scale])
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly
  }, [viewOnly])

  if (!conn) return null

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <Monitor size={14} className="text-dim shrink-0" />
        <span className="text-xs text-dim mono">
          <span className="text-accent">{conn.host}</span>:{conn.port}
        </span>
        {desktopName && (
          <span className="text-xs text-faint truncate max-w-[200px]">— {desktopName}</span>
        )}
        <div className="flex-1" />
        <Tooltip label={t('vnc.ctrlAltDel')}>
          <button
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
          >
            <Keyboard size={14} />
          </button>
        </Tooltip>
        <Tooltip label={scale ? t('vnc.originalSize') : t('vnc.fitWindow')}>
          <button
            onClick={() => setScale(s => !s)}
            className={`size-7 flex items-center justify-center rounded-md transition-colors ${scale ? 'text-accent bg-accent-dim' : 'text-dim hover:text-fg hover:bg-hover'}`}
          >
            <Maximize2 size={14} />
          </button>
        </Tooltip>
        <Tooltip label={viewOnly ? t('vnc.interactive') : t('vnc.viewOnly')}>
          <button
            onClick={() => setViewOnly(v => !v)}
            className={`size-7 flex items-center justify-center rounded-md transition-colors ${viewOnly ? 'text-accent bg-accent-dim' : 'text-dim hover:text-fg hover:bg-hover'}`}
          >
            {viewOnly ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={t('term.disconnect')}>
          <button
            onClick={() => disconnect(tab.connectionId)}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-danger hover:bg-danger/10 transition-colors"
          >
            <Power size={15} />
          </button>
        </Tooltip>
      </div>

      {/* 画面区 */}
      <div className="flex-1 relative min-h-0 bg-black">
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

        {sessionId && status === 'connected' && (
          <div ref={containerRef} className="w-full h-full" />
        )}

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
