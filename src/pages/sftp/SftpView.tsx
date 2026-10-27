import { useEffect, useRef, useState } from 'react'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { startTransferListener, useTransferStore } from '../../stores/transferStore'
import { useT } from '../../i18n/I18nProvider'
import { errorAlert, confirm } from '../../components/ui'
import { FilePane, type PaneHandle } from './FilePane'
import { InstallPkgModal } from './InstallPkgModal'
import { TransferPanel } from './TransferPanel'
import type { SessionTab } from '../../../electron/shared/types'

// 订阅主进程传输事件（幂等）
startTransferListener()

/** SFTP 双栏视图：左本地 / 右远程 + 底部传输队列 */
export function SftpView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const status = useSessionStore(s => s.connSessions[tab.connectionId]?.status)
  const sshSessionId = useSessionStore(s => s.connSessions[tab.connectionId]?.sshSessionId ?? null)
  const error = useSessionStore(s => s.connSessions[tab.connectionId]?.error)
  const reconnect = useSessionStore(s => s.reconnect)
  const setExpanded = useTransferStore(s => s.setExpanded)

  const localRef = useRef<PaneHandle>(null)
  const remoteRef = useRef<PaneHandle>(null)
  const refreshTimer = useRef<number | undefined>(undefined)
  /** 待安装 tar 后继续执行的打包任务 */
  const [packAfterInstall, setPackAfterInstall] = useState<{
    kind: 'upload' | 'download'
    paths: string[]
  } | null>(null)

  // 传输完成 → 防抖刷新目标面板
  useEffect(() => {
    const off = window.api.onTransfer(item => {
      if (item.connectionId !== tab.connectionId) return
      if (item.status !== 'done' && item.status !== 'error' && item.status !== 'cancelled') return
      window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => {
        if (item.direction === 'upload') remoteRef.current?.refresh()
        else localRef.current?.refresh()
      }, 350)
    })
    return () => {
      off()
      window.clearTimeout(refreshTimer.current)
    }
  }, [tab.connectionId])

  if (!conn) return null

  const sessionId = status === 'connected' ? sshSessionId : null

  const doUpload = (paths: string[]) => {
    const target = remoteRef.current?.getDir()
    if (!sessionId || !target || !paths.length) return
    window.api
      .sftpUpload(sessionId, paths, target)
      .then(ids => {
        // 用户取消上传或全部跳过时不展开传输面板
        if (ids.length) setExpanded(true)
      })
      .catch(e => void errorAlert(t('sftp.uploadFailed'), e))
  }

  const doDownload = (paths: string[]) => {
    const target = localRef.current?.getDir()
    if (!sessionId || !target || !paths.length) return
    window.api
      .sftpDownload(sessionId, paths, target)
      .then(ids => {
        if (ids.length) setExpanded(true)
      })
      .catch(e => void errorAlert(t('sftp.downloadFailed'), e))
  }

  /** 来源侧 → 目标动作 */
  const handleTransfer = (sourceSide: 'local' | 'remote', paths: string[]) => {
    if (sourceSide === 'local') doUpload(paths)
    else doDownload(paths)
  }

  /**
   * 打包前确保远端有 tar：缺失时询问是否安装，
   * 用户同意则记录待续任务并返回 false（由安装弹窗回调重试）。
   */
  const ensureTar = async (kind: 'upload' | 'download', paths: string[]): Promise<boolean> => {
    if (!sessionId) return false
    const hasTar = await window.api.sftpHasTar(sessionId).catch(() => true)
    if (hasTar) return true
    const ok = await confirm({
      title: t('sftp.tarMissingTitle'),
      content: t('sftp.tarMissingPrompt'),
      okText: t('sftp.tarInstallNow'),
      cancelText: t('common.cancel'),
    })
    if (ok) setPackAfterInstall({ kind, paths })
    return false
  }

  /** 打包压缩上传：本地选中项 → 远程当前目录；远端无 tar 时询问是否安装 */
  const doPackUpload = async (paths: string[]) => {
    const target = remoteRef.current?.getDir()
    if (!sessionId || !target || !paths.length) return
    if (!(await ensureTar('upload', paths))) return
    window.api
      .sftpUploadPack(sessionId, paths, target)
      .then(() => setExpanded(true))
      .catch(e => void errorAlert(t('sftp.uploadFailed'), e))
  }

  /** 打包压缩下载：远程选中项 → 本地当前目录；远端无 tar 时询问是否安装 */
  const doPackDownload = async (paths: string[]) => {
    const target = localRef.current?.getDir()
    if (!sessionId || !target || !paths.length) return
    if (!(await ensureTar('download', paths))) return
    window.api
      .sftpDownloadPack(sessionId, paths, target)
      .then(ids => {
        if (ids.length) setExpanded(true)
      })
      .catch(e => void errorAlert(t('sftp.downloadFailed'), e))
  }

  const handlePack = (sourceSide: 'local' | 'remote', paths: string[]) => {
    if (sourceSide === 'local') void doPackUpload(paths)
    else void doPackDownload(paths)
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      <div className="flex-1 min-h-0 relative">
        {sessionId ? (
          <div className="grid grid-cols-2 grid-rows-1 h-full">
            <div className="min-w-0 h-full">
              <FilePane
                ref={localRef}
                side="local"
                sessionId={sessionId}
                onTransfer={handleTransfer}
                onPack={handlePack}
              />
            </div>
            <div className="min-w-0 h-full border-l border-bd">
              <FilePane
                ref={remoteRef}
                key={sessionId}
                side="remote"
                sessionId={sessionId}
                onTransfer={handleTransfer}
                onPack={handlePack}
              />
            </div>
          </div>
        ) : status === 'connecting' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-dim">
            <div className="text-xs">{t('term.connecting', { target: `${conn.host}:${conn.port}` })}</div>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="text-sm text-danger">{t('sftp.noSession')}</div>
            {error && (
              <div className="text-xs text-faint max-w-md text-center break-all selectable">{error}</div>
            )}
            <button
              onClick={() => void reconnect(tab.connectionId)}
              className="mt-1 text-xs text-accent hover:underline"
            >
              {t('term.reconnect')}
            </button>
          </div>
        )}
      </div>
      <TransferPanel />
      {/* 远程 tar 安装：实时日志弹窗，成功后自动继续打包上传/下载 */}
      {sessionId && packAfterInstall && (
        <InstallPkgModal
          sessionId={sessionId}
          pkg="tar"
          onClose={() => setPackAfterInstall(null)}
          onDone={success => {
            const req = packAfterInstall
            setPackAfterInstall(null)
            if (!success || !req) return
            if (req.kind === 'upload') void doPackUpload(req.paths)
            else void doPackDownload(req.paths)
          }}
        />
      )}
    </div>
  )
}
