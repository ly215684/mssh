import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, File, Folder, FolderInput, RefreshCw } from 'lucide-react'
import { Button, Modal, Spinner, Tooltip } from '../../components/ui'
import { useT } from '../../i18n/I18nProvider'
import { baseName, parentPath } from '../../utils/files'
import type { FileInfo } from '../../../electron/shared/types'

/** 待移动条目 */
export interface MoveItem {
  path: string
  isDir: boolean
}

interface MoveTargetModalProps {
  open: boolean
  sessionId: string
  /** 待移动的远程条目（文件或文件夹） */
  items: MoveItem[]
  onClose: () => void
  /** 确认移动；抛错时弹窗保留并展示错误 */
  onMove: (targetDir: string) => Promise<void>
}

/** 远程移动目标目录选择器：仅浏览文件夹 */
export function MoveTargetModal({ open, sessionId, items, onClose, onMove }: MoveTargetModalProps) {
  const t = useT()
  const [cwd, setCwd] = useState('/')
  const [pathInput, setPathInput] = useState('/')
  const [dirs, setDirs] = useState<FileInfo[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const paths = items.map(i => i.path)

  const loadDir = useCallback(
    async (dir: string) => {
      if (!dir) return
      setBrowsing(true)
      setErr(null)
      try {
        const list = await window.api.sftpList(sessionId, dir)
        setDirs(list.filter(f => f.isDir))
        setCwd(dir)
        setPathInput(dir)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBrowsing(false)
      }
    },
    [sessionId],
  )

  // 每次打开时回到根目录
  useEffect(() => {
    if (open) {
      setErr(null)
      void loadDir('/')
    }
  }, [open, loadDir])

  // 目标非法：与某个源路径相同，或位于某个源文件夹内部（防止移入自身/子目录）
  const invalidPath = (() => {
    for (const p of paths) {
      const src = p.replace(/\/+$/, '')
      if (cwd === src) return true
      if (cwd.startsWith(`${src}/`)) return true
    }
    return false
  })()

  const confirm = async () => {
    if (invalidPath || moving) return
    setErr(null)
    setMoving(true)
    try {
      await onMove(cwd)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMoving(false)
    }
  }

  const up = parentPath(cwd)

  return (
    <Modal
      open={open}
      onClose={onClose}
      maskClosable={false}
      width={620}
      title={
        <span className="inline-flex items-center gap-2">
          <FolderInput size={15} className="text-accent" />
          {t('sftp.moveTitle')}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose} disabled={moving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<FolderInput size={14} />}
            disabled={invalidPath}
            loading={moving}
            onClick={() => void confirm()}
          >
            {t('sftp.moveHere')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <div className="text-xs text-dim leading-relaxed">
          {t('sftp.moveSources', { count: paths.length })}
        </div>
        <div className="rounded-md border border-bd bg-soft px-3 py-2 max-h-20 overflow-y-auto flex flex-wrap gap-1.5">
          {items.map(it => (
            <span
              key={it.path}
              className="inline-flex items-center gap-1 text-[11px] text-dim bg-elevated border border-bd rounded px-1.5 py-0.5"
            >
              {it.isDir ? (
                <Folder size={11} className="text-accent shrink-0" />
              ) : (
                <File size={11} className="text-dim shrink-0" />
              )}
              <span className="max-w-[260px] truncate" title={it.path}>
                {baseName(it.path)}
              </span>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <Tooltip label={t('sftp.up')}>
            <button
              disabled={!up}
              onClick={() => up && void loadDir(up)}
              className="size-7 shrink-0 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          </Tooltip>
          <input
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void loadDir(pathInput.trim())
            }}
            spellCheck={false}
            className="flex-1 h-8 px-2.5 rounded-md bg-input border border-bd text-[13px] text-fg outline-none focus:border-accent font-mono"
          />
          <Tooltip label={t('common.refresh')}>
            <button
              onClick={() => void loadDir(cwd)}
              className="size-7 shrink-0 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
            >
              <RefreshCw size={14} className={browsing ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
        </div>

        <div className="h-[34vh] overflow-auto rounded-md border border-bd bg-soft py-1">
          {browsing ? (
            <div className="flex items-center justify-center h-full text-dim gap-2">
              <Spinner size={16} />
              <span className="text-xs">{t('common.loading')}</span>
            </div>
          ) : dirs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-faint px-4 text-center">
              {t('sftp.moveEmpty')}
            </div>
          ) : (
            dirs.map(f => (
              <div
                key={f.path}
                onClick={() => void loadDir(f.path)}
                className="mx-1 h-8 px-2.5 flex items-center gap-2 text-[13px] rounded-sm cursor-pointer text-fg hover:bg-hover"
              >
                <Folder size={14} className="text-accent shrink-0" />
                <span className="truncate" title={f.name}>
                  {f.name}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="text-xs">
          {invalidPath ? (
            <span className="text-danger">{t('sftp.moveInvalid')}</span>
          ) : (
            <span className="text-faint">{t('sftp.moveTarget', { dir: cwd })}</span>
          )}
        </div>
        {err && <div className="text-xs text-danger break-all">{err}</div>}
      </div>
    </Modal>
  )
}
