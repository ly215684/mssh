import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  ArrowUp,
  Download,
  FilePlus,
  FolderPlus,
  HardDrive,
  MonitorDown,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
  Upload,
} from 'lucide-react'
import type { FileInfo } from '../../../electron/shared/types'
import { useT } from '../../i18n/I18nProvider'
import { getGlobalT } from '../../i18n/I18nProvider'
import {
  Empty,
  Spinner,
  Tooltip,
  confirm,
  errorAlert,
  useContextMenu,
  type MenuItem,
} from '../../components/ui'
import {
  fileIcon,
  fileIconCls,
  formatSize,
  isArchive,
  joinPath,
  matchFilter,
  parentPath,
  type FilterKey,
} from '../../utils/files'
import { FileEditor } from './FileEditor'

/** 跨面板传输：来源侧 + 路径列表 */
export type TransferSource = 'local' | 'remote'

export interface PaneHandle {
  getDir: () => string
  refresh: () => void
}

interface FilePaneProps {
  side: 'local' | 'remote'
  sessionId: string | null
  /** 发起跨栏传输（sourceSide 为文件来源侧） */
  onTransfer: (sourceSide: TransferSource, paths: string[]) => void
  onSelectionChange?: (paths: string[]) => void
}

/** 内部拖拽 payload：按来源侧命名，对侧面板据此接收 */
const SRC_MIME: Record<TransferSource, string> = {
  local: 'application/x-mssh-local',
  remote: 'application/x-mssh-remote',
}

const FILTERS: FilterKey[] = ['all', 'docs', 'images', 'archives']

function isAbsolutePath(p: string): boolean {
  // Windows: 'C:'、'C:\'、'C:\Users\x'、UNC '\\srv\share'；POSIX: '/...'
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)
}

/** 本地输入规范化：'c' / 'c:' / 'c:\' → 'C:\'（Windows 盘符跳转习惯） */
function normalizeLocalInput(raw: string): string {
  const m = raw.match(/^([a-zA-Z]):?\\?$/)
  if (m) return `${m[1].toUpperCase()}:\\`
  return raw
}

function fmtTime(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function IconBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={`size-7 flex items-center justify-center rounded-md transition-colors ${
          disabled
            ? 'opacity-35 cursor-not-allowed text-dim'
            : danger
              ? 'text-dim hover:text-danger hover:bg-danger/10'
              : 'text-dim hover:text-fg hover:bg-hover'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** 单侧文件面板（本地 / 远程通用） */
export const FilePane = forwardRef<PaneHandle, FilePaneProps>(function FilePane(
  { side, sessionId, onTransfer, onSelectionChange },
  ref,
) {
  const t = useT()
  const isRemote = side === 'remote'

  const [dir, setDir] = useState('')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<FileInfo[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirValue, setMkdirValue] = useState('')
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchValue, setTouchValue] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [editorPath, setEditorPath] = useState<string | null>(null)
  /** 进行中的文件操作文案（删除/新建/解压等），用于遮罩反馈 */
  const [opLabel, setOpLabel] = useState<string | null>(null)

  const dirRef = useRef('')
  const nonceRef = useRef(0)
  const [, force] = useState(0)
  const lastIndexRef = useRef(-1)
  const dragDepth = useRef(0)
  const selCbRef = useRef(onSelectionChange)
  const renameBusy = useRef(false)
  const mkdirBusy = useRef(false)
  const touchBusyRef = useRef(false)
  const { openContextMenu } = useContextMenu()

  useEffect(() => {
    selCbRef.current = onSelectionChange
  })

  const refresh = useCallback(() => {
    nonceRef.current += 1
    force(n => n + 1)
  }, [])

  /** 执行文件操作：期间显示遮罩动画，完成/失败后关闭 */
  const runOp = useCallback(async (label: string, fn: () => Promise<void>) => {
    setOpLabel(label)
    try {
      await fn()
    } finally {
      setOpLabel(null)
    }
  }, [])

  /** 跳转到系统桌面目录 */
  const goDesktop = () => {
    void window.api
      .localDesktop()
      .then(p => void loadTo(p))
      .catch(e => void errorAlert(getGlobalT()('sftp.opFailed'), e))
  }

  useImperativeHandle(ref, () => ({ getDir: () => dirRef.current, refresh }), [refresh])

  const commitDir = useCallback((target: string, list: FileInfo[]) => {
    dirRef.current = target
    setDir(target)
    setInput(target)
    setEntries(list)
    setSelected(new Set())
    lastIndexRef.current = -1
    setRenaming(null)
    selCbRef.current?.([])
  }, [])

  /** 加载目录；失败弹窗提示并回退路径显示 */
  const loadTo = useCallback(
    async (raw: string) => {
      const gt = getGlobalT()
      if (isRemote && !sessionId) return
      setLoading(true)
      try {
        let target = raw.trim()
        if (isRemote && sessionId) {
          if (!target || target.startsWith('~') || !target.startsWith('/')) {
            target = await window.api.sftpRealpath(sessionId, target || '.')
          }
          commitDir(target, await window.api.sftpList(sessionId, target))
        } else {
          if (!target) target = await window.api.localHome()
          else {
            target = normalizeLocalInput(target)
            if (!isAbsolutePath(target) && dirRef.current) target = joinPath(dirRef.current, target)
          }
          commitDir(target, await window.api.localList(target))
        }
      } catch (e) {
        void errorAlert(gt('sftp.loadFailed'), e)
        setInput(dirRef.current)
      } finally {
        setLoading(false)
      }
    },
    [isRemote, sessionId, commitDir],
  )

  // 首次加载 / 会话变化 / 手动刷新
  useEffect(() => {
    void loadTo(dirRef.current)
  }, [loadTo, nonceRef.current]) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = entries ? entries.filter(f => matchFilter(f, filter)) : []

  const applySelection = useCallback((next: Set<string>, lastIndex?: number) => {
    setSelected(next)
    if (lastIndex !== undefined) lastIndexRef.current = lastIndex
    selCbRef.current?.([...next].map(n => joinPath(dirRef.current, n)))
  }, [])

  const selPaths = useCallback(
    () => [...selected].map(n => joinPath(dirRef.current, n)),
    [selected],
  )

  // ---------- 操作 ----------

  const onRowClick = (e: ReactMouseEvent, f: FileInfo, idx: number) => {
    e.stopPropagation()
    if (e.shiftKey && lastIndexRef.current >= 0) {
      const a = Math.min(lastIndexRef.current, idx)
      const b = Math.max(lastIndexRef.current, idx)
      applySelection(new Set(visible.slice(a, b + 1).map(x => x.name)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(f.name)) next.delete(f.name)
      else next.add(f.name)
      applySelection(next, idx)
      return
    }
    applySelection(new Set([f.name]), idx)
  }

  const openLocal = (f: FileInfo) => {
    void window.api.openPath(f.path).then(ok => {
      if (!ok) void errorAlert(getGlobalT()('sftp.openFailed'), f.path)
    })
  }

  const onRowOpen = (f: FileInfo) => {
    if (f.isDir) {
      void loadTo(joinPath(dirRef.current, f.name))
      return
    }
    if (!isRemote) openLocal(f)
    else onTransfer('remote', [f.path])
  }

  const doDelete = useCallback(
    async (names?: string[]) => {
      const targets = names ?? [...selected]
      if (!targets.length) return
      const ok = await confirm({
        title: t('ctx.deleteFile'),
        content: t('sftp.confirmDelete', { count: targets.length }),
        danger: true,
      })
      if (!ok) return
      await runOp(t('sftp.opDeleting'), async () => {
        try {
          for (const n of targets) {
            const p = joinPath(dirRef.current, n)
            if (isRemote && sessionId) await window.api.sftpRm(sessionId, p)
            else if (!isRemote) await window.api.localRm(p)
          }
        } catch (e) {
          void errorAlert(getGlobalT()('sftp.opFailed'), e)
        }
        refresh()
      })
    },
    [selected, isRemote, sessionId, t, refresh, runOp],
  )

  const commitRename = useCallback(async () => {
    if (renameBusy.current || !renaming) return
    renameBusy.current = true
    const from = joinPath(dirRef.current, renaming)
    const newName = renameValue.trim()
    setRenaming(null)
    try {
      if (newName && newName !== renaming) {
        const to = joinPath(dirRef.current, newName)
        await runOp(t('sftp.opRenaming'), async () => {
          try {
            if (isRemote && sessionId) await window.api.sftpRename(sessionId, from, to)
            else if (!isRemote) await window.api.localRename(from, to)
            refresh()
          } catch (e) {
            void errorAlert(getGlobalT()('sftp.opFailed'), e)
          }
        })
      }
    } finally {
      renameBusy.current = false
    }
  }, [renaming, renameValue, isRemote, sessionId, refresh, runOp, t])

  const commitMkdir = useCallback(async () => {
    if (mkdirBusy.current) return
    mkdirBusy.current = true
    const name = mkdirValue.trim()
    setMkdirOpen(false)
    try {
      if (name) {
        const target = joinPath(dirRef.current, name)
        await runOp(t('sftp.opCreatingFolder'), async () => {
          try {
            if (isRemote && sessionId) await window.api.sftpMkdir(sessionId, target)
            else if (!isRemote) await window.api.localMkdir(target)
            refresh()
          } catch (e) {
            void errorAlert(getGlobalT()('sftp.opFailed'), e)
          }
        })
      }
    } finally {
      mkdirBusy.current = false
    }
  }, [mkdirValue, isRemote, sessionId, refresh, runOp, t])

  const commitTouch = useCallback(async () => {
    if (touchBusyRef.current) return
    touchBusyRef.current = true
    const name = touchValue.trim()
    setTouchOpen(false)
    try {
      if (name) {
        const target = joinPath(dirRef.current, name)
        await runOp(t('sftp.opCreatingFile'), async () => {
          try {
            if (isRemote && sessionId) await window.api.sftpTouch(sessionId, target)
            else if (!isRemote) await window.api.localTouch(target)
            refresh()
          } catch (e) {
            void errorAlert(getGlobalT()('sftp.opFailed'), e)
          }
        })
      }
    } finally {
      touchBusyRef.current = false
    }
  }, [touchValue, isRemote, sessionId, refresh, runOp, t])

  const doExtract = useCallback(
    async (f: FileInfo) => {
      if (f.isDir || !isArchive(f.name)) return
      await runOp(t('sftp.opExtracting', { name: f.name }), async () => {
        try {
          if (isRemote && sessionId) await window.api.sftpExtract(sessionId, f.path)
          else if (!isRemote) await window.api.localExtract(f.path)
          refresh()
        } catch (e) {
          void errorAlert(getGlobalT()('sftp.opFailed'), e)
        }
      })
    },
    [isRemote, sessionId, refresh, runOp, t],
  )

  // ---------- 右键菜单 ----------

  const pickRow = (key: string, f: FileInfo) => {
    switch (key) {
      case 'open':
        openLocal(f)
        break
      case 'download':
        onTransfer('remote', [f.path])
        break
      case 'edit':
        setEditorPath(f.path)
        break
      case 'extract':
        void doExtract(f)
        break
      case 'rename':
        setRenameValue(f.name)
        setRenaming(f.name)
        break
      case 'delete':
        void doDelete([f.name])
        break
    }
  }

  const rowMenu = (f: FileInfo): MenuItem[] => [
    ...(isRemote ? [{ key: 'edit', label: t('ctx.edit') }] : []),
    ...(!f.isDir && isArchive(f.name) ? [{ key: 'extract', label: t('ctx.extract') }] : []),
    ...(isRemote ? [{ key: 'download', label: t('ctx.download') }] : []),
    ...(!isRemote && !f.isDir ? [{ key: 'open', label: t('ctx.open') }] : []),
    { key: 'rename', label: t('common.rename') },
    { key: 'divider', label: '', divider: true },
    { key: 'delete', label: t('common.delete'), danger: true },
  ]

  const blankMenu = (): MenuItem[] => [
    { key: 'refresh', label: t('common.refresh') },
    { key: 'mkdir', label: t('ctx.mkdir') },
    { key: 'touch', label: t('ctx.touch') },
  ]

  // ---------- 拖拽 ----------

  const onDragStart = (e: ReactDragEvent, f: FileInfo) => {
    let names = selected
    if (!selected.has(f.name)) {
      names = new Set([f.name])
      applySelection(names)
    }
    e.dataTransfer.setData(
      SRC_MIME[side],
      JSON.stringify({ side, paths: [...names].map(n => joinPath(dirRef.current, n)) }),
    )
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const canDrop = (e: ReactDragEvent) => {
    const types = e.dataTransfer?.types
    if (!types) return false
    const otherMime = SRC_MIME[side === 'local' ? 'remote' : 'local']
    if (types.includes(otherMime)) return true
    return isRemote && types.includes('Files')
  }

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const dt = e.dataTransfer
    const otherMime = SRC_MIME[side === 'local' ? 'remote' : 'local']
    const raw = dt.getData(otherMime)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { side: TransferSource; paths: string[] }
        if (parsed.side !== side && parsed.paths?.length) onTransfer(parsed.side, parsed.paths)
      } catch {
        /* 忽略非法数据 */
      }
      return
    }
    if (isRemote && dt.files.length) {
      const paths = Array.from(dt.files).map(f => window.api.pathForFile(f)).filter(Boolean)
      if (paths.length) onTransfer('local', paths)
    }
  }

  // ---------- 渲染 ----------

  const upPath = parentPath(dir)
  const filterLabels: Record<FilterKey, string> = {
    all: t('sftp.filterAll'),
    docs: t('sftp.filterDocs'),
    images: t('sftp.filterImages'),
    archives: t('sftp.filterArchives'),
  }
  const gridCols = 'grid grid-cols-[minmax(0,1fr)_72px_128px] gap-2'
  const canTransfer = selected.size > 0
  const busy = opLabel !== null

  return (
    <div
      className={`flex flex-col h-full min-w-0 relative ${dragOver ? 'bg-accent/5' : ''}`}
      onDragEnter={e => {
        if (!canDrop(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={e => {
        if (!canDrop(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* 工具行 */}
      <div className="flex items-center gap-1.5 h-9 px-2 border-b border-bd shrink-0">
        {isRemote ? (
          <Server size={14} className="text-dim shrink-0" />
        ) : (
          <HardDrive size={14} className="text-dim shrink-0" />
        )}
        <span className="text-xs font-medium text-fg shrink-0">
          {t(isRemote ? 'sftp.remote' : 'sftp.local')}
        </span>
        {selected.size > 0 && (
          <span className="text-[11px] text-accent shrink-0">{t('sftp.selected', { count: selected.size })}</span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 mr-0.5">
          {FILTERS.map(fk => (
            <button
              key={fk}
              type="button"
              onClick={() => setFilter(fk)}
              className={`px-1.5 h-6 rounded text-[11px] transition-colors ${
                filter === fk ? 'bg-accent-dim text-accent' : 'text-dim hover:text-fg hover:bg-hover'
              }`}
            >
              {filterLabels[fk]}
            </button>
          ))}
        </div>
        <IconBtn label={t('common.refresh')} onClick={refresh} disabled={busy}>
          <RefreshCw size={14} />
        </IconBtn>
        <IconBtn label={t('ctx.mkdir')} disabled={busy} onClick={() => { setMkdirValue(''); setMkdirOpen(true) }}>
          <FolderPlus size={14} />
        </IconBtn>
        <IconBtn label={t('ctx.touch')} disabled={busy} onClick={() => { setTouchValue(''); setTouchOpen(true) }}>
          <FilePlus size={14} />
        </IconBtn>
        <IconBtn label={t('common.rename')} disabled={busy || selected.size !== 1} onClick={() => {
          const name = [...selected][0]
          if (name) { setRenameValue(name); setRenaming(name) }
        }}>
          <Pencil size={14} />
        </IconBtn>
        <IconBtn label={t('common.delete')} danger disabled={busy || !canTransfer} onClick={() => void doDelete()}>
          <Trash2 size={14} />
        </IconBtn>
        <IconBtn
          label={t(isRemote ? 'ctx.download' : 'ctx.upload')}
          disabled={busy || !canTransfer}
          onClick={() => onTransfer(side, selPaths())}
        >
          {isRemote ? <Download size={14} /> : <Upload size={14} />}
        </IconBtn>
        {isRemote && (
          <IconBtn
            label={t('ctx.edit')}
            disabled={busy || selected.size !== 1 || (entries?.find(e => e.name === [...selected][0])?.isDir ?? true)}
            onClick={() => {
              const name = [...selected][0]
              if (name) setEditorPath(joinPath(dirRef.current, name))
            }}
          >
            <Pencil size={14} />
          </IconBtn>
        )}
      </div>

      {/* 路径行 */}
      <div className="flex items-center gap-1.5 h-9 px-2 border-b border-bd shrink-0">
        <IconBtn
          label={t('sftp.up')}
          disabled={!upPath}
          onClick={() => upPath && void loadTo(upPath)}
        >
          <ArrowUp size={14} />
        </IconBtn>
        {!isRemote && (
          <IconBtn label={t('sftp.desktop')} onClick={goDesktop}>
            <MonitorDown size={14} />
          </IconBtn>
        )}
        <input
          value={input}
          spellCheck={false}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = input.trim()
              if (v && v !== dirRef.current) void loadTo(v)
              else setInput(dirRef.current)
            }
          }}
          onBlur={() => setInput(dirRef.current)}
          placeholder={t('sftp.pathPh')}
          className="flex-1 h-7 bg-input border border-bd rounded-md px-2.5 text-xs text-fg placeholder:text-faint mono outline-none focus:border-accent hover:border-bd-strong transition-colors min-w-0"
        />
      </div>

      {/* 文件列表 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto relative select-none"
        onClick={() => {
          if (selected.size) applySelection(new Set())
        }}
        onContextMenu={e =>
          openContextMenu(
            e,
            blankMenu(),
            key => {
              if (key === 'refresh') refresh()
              else if (key === 'mkdir') { setMkdirValue(''); setMkdirOpen(true) }
              else if (key === 'touch') { setTouchValue(''); setTouchOpen(true) }
            },
          )
        }
      >
        {/* 表头 */}
        <div
          className={`${gridCols} sticky top-0 z-10 h-7 px-3 items-center text-[11px] text-faint bg-bg border-b border-bd`}
        >
          <span>{t('common.name')}</span>
          <span className="text-right">{t('sftp.size')}</span>
          <span>{t('sftp.mtime')}</span>
        </div>

        {/* 新建文件夹行 */}
        {mkdirOpen && (
          <div className="flex items-center gap-2 h-8 px-3 bg-hover/40">
            <FolderPlus size={15} className="text-accent shrink-0" />
            <input
              autoFocus
              value={mkdirValue}
              spellCheck={false}
              onChange={e => setMkdirValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void commitMkdir()
                else if (e.key === 'Escape') setMkdirOpen(false)
              }}
              onBlur={() => setMkdirOpen(false)}
              placeholder={t('sftp.mkdirPh')}
              className="flex-1 bg-transparent text-[13px] text-fg placeholder:text-faint outline-none min-w-0"
            />
          </div>
        )}

        {touchOpen && (
          <div className="flex items-center gap-2 h-8 px-3 bg-hover/40">
            <FilePlus size={15} className="text-accent shrink-0" />
            <input
              autoFocus
              value={touchValue}
              spellCheck={false}
              onChange={e => setTouchValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void commitTouch()
                else if (e.key === 'Escape') setTouchOpen(false)
              }}
              onBlur={() => setTouchOpen(false)}
              placeholder={t('ctx.touch')}
              className="flex-1 bg-transparent text-[13px] text-fg placeholder:text-faint outline-none min-w-0"
            />
          </div>
        )}

        {visible.map((f, idx) => {
          const Icon = fileIcon(f)
          const sel = selected.has(f.name)
          if (renaming === f.name) {
            return (
              <div key={f.name} className="flex items-center gap-2 h-8 px-3 bg-hover/40">
                <Icon size={15} className={fileIconCls(f)} />
                <input
                  autoFocus
                  value={renameValue}
                  spellCheck={false}
                  onChange={e => setRenameValue(e.target.value)}
                  onFocus={e => e.currentTarget.select()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void commitRename()
                    else if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => void commitRename()}
                  className="flex-1 bg-transparent text-[13px] text-fg outline-none min-w-0"
                />
              </div>
            )
          }
          return (
            <div
              key={f.name}
              onClick={e => onRowClick(e, f, idx)}
              onDoubleClick={() => onRowOpen(f)}
              onContextMenu={e => {
                if (!selected.has(f.name)) applySelection(new Set([f.name]), idx)
                openContextMenu(e, rowMenu(f), key => pickRow(key, f))
              }}
              draggable
              onDragStart={e => onDragStart(e, f)}
              className={`${gridCols} h-8 px-3 items-center text-[13px] cursor-default transition-colors ${
                sel ? 'bg-accent-dim/70 text-accent' : 'text-fg hover:bg-hover'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Icon size={15} className={`shrink-0 ${sel ? '' : fileIconCls(f)}`} />
                <span className="truncate" title={f.name}>
                  {f.name}
                  {f.symlink ? ' →' : ''}
                </span>
              </span>
              <span className={`text-right text-xs ${sel ? '' : 'text-dim'}`}>
                {f.isDir ? '-' : formatSize(f.size)}
              </span>
              <span className={`text-xs truncate ${sel ? '' : 'text-faint'}`}>{fmtTime(f.mtime)}</span>
            </div>
          )
        })}

        {!loading && entries && visible.length === 0 && (
          <Empty text={t('common.empty')} className="py-10" />
        )}

        {(loading || opLabel) && (
          <div className="absolute inset-0 bg-bg/50 flex flex-col items-center justify-center gap-2 z-10">
            <Spinner size={20} />
            {opLabel && <div className="text-xs text-dim">{opLabel}</div>}
          </div>
        )}
      </div>

      {/* 远程文本编辑器 */}
      <FileEditor
        open={editorPath !== null}
        sessionId={sessionId}
        path={editorPath ?? ''}
        onClose={() => setEditorPath(null)}
      />
    </div>
  )
})
