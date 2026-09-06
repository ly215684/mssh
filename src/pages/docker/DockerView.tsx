import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ArrowUp,
  Boxes,
  CheckCircle2,
  FileText,
  Folder,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'
import type {
  DockerContainer,
  DockerImage,
  FileInfo,
  SessionTab,
} from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useT } from '../../i18n/I18nProvider'
import {
  Button,
  Empty,
  Modal,
  Spinner,
  Switch,
  Tabs,
  Tooltip,
  confirm,
  errorAlert,
  message,
  useContextMenu,
  type MenuItem,
} from '../../components/ui'
import { baseName, parentPath } from '../../utils/files'

/** shell 单引号安全包裹 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 解析 docker --format '{{json .}}' 的 JSONL 输出 */
function parseJsonl(out: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of out.split('\n')) {
    const l = line.trim()
    if (!l || l[0] !== '{') continue
    try {
      rows.push(JSON.parse(l) as Record<string, unknown>)
    } catch {
      // 跳过非 JSON 行
    }
  }
  return rows
}

/** 容器状态点颜色 */
function stateColor(state: string): string {
  switch (state) {
    case 'running':
      return 'text-accent'
    case 'paused':
    case 'restarting':
      return 'text-warning'
    case 'dead':
      return 'text-danger'
    default:
      return 'text-faint'
  }
}

/** Docker 管理标签页：容器 / 镜像列表 + 右键操作 + 日志 + compose 启动 */
export function DockerView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const status = useSessionStore(s => s.connSessions[tab.connectionId]?.status)
  const sshSessionId = useSessionStore(
    s => s.connSessions[tab.connectionId]?.sshSessionId ?? null,
  )
  const connError = useSessionStore(s => s.connSessions[tab.connectionId]?.error)
  const reconnect = useSessionStore(s => s.reconnect)
  const { openContextMenu } = useContextMenu()

  const [view, setView] = useState<'containers' | 'images'>('containers')
  const [loading, setLoading] = useState(false)
  const [dockerErr, setDockerErr] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [containers, setContainers] = useState<DockerContainer[]>([])
  const [images, setImages] = useState<DockerImage[]>([])
  /** 进行中的操作文案，用于内容区遮罩反馈 */
  const [opLabel, setOpLabel] = useState<string | null>(null)

  /** 执行远程操作：期间显示遮罩动画，完成/失败后关闭 */
  const runOp = useCallback(async (label: string, fn: () => Promise<void>) => {
    setOpLabel(label)
    try {
      await fn()
    } finally {
      setOpLabel(null)
    }
  }, [])
  const [logTarget, setLogTarget] = useState<DockerContainer | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)

  const sessionId = status === 'connected' ? sshSessionId : null

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setDockerErr(null)
    try {
      // 先探测 docker 是否可用
      const ver = await window.api.sshExec(
        sessionId,
        "docker version --format '{{.Server.Version}}'",
      )
      if (ver.code !== 0 || !ver.stdout.trim()) {
        const msg = (ver.stderr || ver.stdout).trim()
        setVersion('')
        setContainers([])
        setImages([])
        if (/permission denied/i.test(msg)) setDockerErr(t('docker.errPerm'))
        else if (/command not found|no such file|not found/i.test(msg))
          setDockerErr(t('docker.errInstall'))
        else setDockerErr(msg || t('docker.errUnavailable'))
        return
      }
      setVersion(ver.stdout.trim())

      const [psRes, imgRes] = await Promise.all([
        window.api.sshExec(sessionId, "docker ps -a --format '{{json .}}'"),
        window.api.sshExec(sessionId, "docker images --format '{{json .}}'"),
      ])
      setContainers(
        parseJsonl(psRes.stdout).map(r => ({
          id: String(r.ID ?? ''),
          name: String(r.Names ?? ''),
          image: String(r.Image ?? ''),
          state: String(r.State ?? '').toLowerCase(),
          status: String(r.Status ?? ''),
          ports: String(r.Ports ?? ''),
        })),
      )
      setImages(
        parseJsonl(imgRes.stdout).map(r => ({
          id: String(r.ID ?? ''),
          repository: String(r.Repository ?? ''),
          tag: String(r.Tag ?? ''),
          size: String(r.Size ?? ''),
        })),
      )
    } catch (e) {
      setDockerErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId, t])

  useEffect(() => {
    if (sessionId) void load()
  }, [sessionId, load])

  /** 容器启动 / 停止 / 重启 */
  const containerAction = useCallback(
    async (c: DockerContainer, action: 'start' | 'stop' | 'restart') => {
      if (!sessionId) return
      const ok = await confirm({
        title: t(`docker.${action}Title`),
        content: t(`docker.${action}Confirm`, { name: c.name }),
        danger: action !== 'start',
      })
      if (!ok) return
      await runOp(t('docker.opRunning'), async () => {
        try {
          const res = await window.api.sshExec(sessionId, `docker ${action} ${shq(c.id)}`)
          if (res.code !== 0) {
            await errorAlert(t('docker.actionFailed'), res.stderr.trim() || res.stdout.trim())
            return
          }
          message.success(t(`docker.${action}Done`, { name: c.name }))
          void load()
        } catch (e) {
          await errorAlert(t('docker.actionFailed'), e)
        }
      })
    },
    [sessionId, t, load, runOp],
  )

  /** 删除容器：运行中强制停止后删除 */
  const removeContainer = useCallback(
    async (c: DockerContainer) => {
      if (!sessionId) return
      const running = c.state === 'running'
      const ok = await confirm({
        title: t('docker.removeContainerTitle'),
        content: t(running ? 'docker.removeContainerRunningConfirm' : 'docker.removeContainerConfirm', { name: c.name }),
        danger: true,
      })
      if (!ok) return
      await runOp(t('docker.opRunning'), async () => {
        try {
          const res = await window.api.sshExec(sessionId, `docker rm -f ${shq(c.id)}`)
          if (res.code !== 0) {
            await errorAlert(t('docker.actionFailed'), res.stderr.trim() || res.stdout.trim())
            return
          }
          message.success(t('docker.removeDone', { name: c.name }))
          void load()
        } catch (e) {
          await errorAlert(t('docker.actionFailed'), e)
        }
      })
    },
    [sessionId, t, load, runOp],
  )

  /** 删除镜像：被容器占用等失败时透出 docker 错误 */
  const removeImage = useCallback(
    async (im: DockerImage) => {
      if (!sessionId) return
      const ok = await confirm({
        title: t('docker.removeImageTitle'),
        content: t('docker.removeImageConfirm', { repo: im.repository, tag: im.tag }),
        danger: true,
      })
      if (!ok) return
      await runOp(t('docker.opRunning'), async () => {
        try {
          const res = await window.api.sshExec(sessionId, `docker rmi ${shq(im.id)}`)
          if (res.code !== 0) {
            await errorAlert(t('docker.actionFailed'), res.stderr.trim() || res.stdout.trim())
            return
          }
          message.success(t('docker.removeDone', { name: `${im.repository}:${im.tag}` }))
          void load()
        } catch (e) {
          await errorAlert(t('docker.actionFailed'), e)
        }
      })
    },
    [sessionId, t, load, runOp],
  )

  /** 容器行右键菜单 */
  const onRowCtx = useCallback(
    (e: ReactMouseEvent, c: DockerContainer) => {
      const running = c.state === 'running'
      const items: MenuItem[] = [
        running
          ? { key: 'stop', label: t('docker.stop'), icon: <Square size={14} />, danger: true }
          : { key: 'start', label: t('docker.start'), icon: <Play size={14} /> },
        {
          key: 'restart',
          label: t('docker.restart'),
          icon: <RotateCw size={14} />,
          disabled: !running,
        },
        { key: 'divider', label: '', divider: true },
        { key: 'logs', label: t('docker.logs'), icon: <ScrollText size={14} /> },
        { key: 'remove', label: t('docker.remove'), icon: <Trash2 size={14} />, danger: true },
      ]
      openContextMenu(e, items, key => {
        if (key === 'logs') setLogTarget(c)
        else if (key === 'remove') void removeContainer(c)
        else void containerAction(c, key as 'start' | 'stop' | 'restart')
      })
    },
    [openContextMenu, t, containerAction, removeContainer],
  )

  /** 镜像行右键菜单 */
  const onImageCtx = useCallback(
    (e: ReactMouseEvent, im: DockerImage) => {
      openContextMenu(e, [{ key: 'remove', label: t('docker.remove'), icon: <Trash2 size={14} />, danger: true }], key => {
        if (key === 'remove') void removeImage(im)
      })
    },
    [openContextMenu, t, removeImage],
  )

  if (!conn) return null

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <span className="text-xs text-dim font-mono inline-flex items-center">
          <Boxes size={13} className="mr-1.5 text-accent" />
          <span className="text-accent">
            {conn.username}@{conn.host}
          </span>
          {version && <span className="text-faint">&nbsp;· Docker {version}</span>}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          icon={<Rocket size={14} />}
          disabled={!sessionId}
          onClick={() => setComposeOpen(true)}
        >
          {t('docker.compose')}
        </Button>
        <Tooltip label={t('common.refresh')}>
          <button
            onClick={() => void load()}
            disabled={!sessionId || loading}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-40"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 relative">
        {sessionId ? (
          <div className="flex flex-col h-full">
            <div className="px-3 pt-2 shrink-0">
              <Tabs
                items={[
                  {
                    key: 'containers',
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        <Boxes size={13} />
                        {t('docker.containers')} ({containers.length})
                      </span>
                    ),
                  },
                  {
                    key: 'images',
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        <ImageIcon size={13} />
                        {t('docker.images')} ({images.length})
                      </span>
                    ),
                  },
                ]}
                active={view}
                onChange={setView}
              />
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
              {loading && containers.length === 0 && images.length === 0 ? (
                <div className="flex items-center justify-center h-full text-dim gap-2">
                  <Spinner size={18} />
                  <span className="text-xs">{t('common.loading')}</span>
                </div>
              ) : dockerErr ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                  <Boxes size={28} strokeWidth={1.5} className="text-faint" />
                  <div className="text-sm text-danger">{t('docker.errUnavailable')}</div>
                  <div className="text-xs text-dim max-w-md selectable break-all">{dockerErr}</div>
                  <Button size="sm" className="mt-1" onClick={() => void load()}>
                    {t('common.refresh')}
                  </Button>
                </div>
              ) : view === 'containers' ? (
                containers.length === 0 ? (
                  <Empty icon={<Boxes size={30} strokeWidth={1.5} />} text={t('docker.noContainers')} />
                ) : (
                  <table className="w-full text-[13px] border-collapse">
                    <thead className="sticky top-0 bg-bg z-10">
                      <tr className="text-dim border-b border-bd">
                        <th className="font-normal px-3 h-9 text-left whitespace-nowrap">
                          {t('docker.colName')}
                        </th>
                        <th className="font-normal px-3 h-9 text-left whitespace-nowrap">
                          {t('docker.colImage')}
                        </th>
                        <th className="font-normal px-3 h-9 text-left w-48 whitespace-nowrap">
                          {t('docker.colStatus')}
                        </th>
                        <th className="font-normal px-3 h-9 text-left whitespace-nowrap">
                          {t('docker.colPorts')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {containers.map(c => (
                        <tr
                          key={c.id}
                          onContextMenu={e => onRowCtx(e, c)}
                          onDoubleClick={() => setLogTarget(c)}
                          className="border-b border-bd/50 hover:bg-hover"
                        >
                          <td className="px-3 h-9">
                            <span className="inline-flex items-center gap-2">
                              <span
                                className={`size-2 rounded-full bg-current shrink-0 ${stateColor(c.state)}`}
                              />
                              <span className="text-fg">{c.name}</span>
                            </span>
                          </td>
                          <td className="px-3 h-9">
                            <span className="text-dim font-mono text-xs max-w-[240px] truncate inline-block align-middle">
                              {c.image}
                            </span>
                          </td>
                          <td className={`px-3 h-9 whitespace-nowrap ${stateColor(c.state)}`}>
                            {c.status}
                          </td>
                          <td className="px-3 h-9">
                            <span className="text-dim font-mono text-xs max-w-[280px] truncate inline-block align-middle">
                              {c.ports || '-'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : images.length === 0 ? (
                <Empty icon={<ImageIcon size={30} strokeWidth={1.5} />} text={t('docker.noImages')} />
              ) : (
                <table className="w-full text-[13px] border-collapse">
                  <thead className="sticky top-0 bg-bg z-10">
                    <tr className="text-dim border-b border-bd">
                      <th className="font-normal px-3 h-9 text-left whitespace-nowrap">
                        {t('docker.colRepo')}
                      </th>
                      <th className="font-normal px-3 h-9 text-left w-32 whitespace-nowrap">
                        {t('docker.colTag')}
                      </th>
                      <th className="font-normal px-3 h-9 text-left w-28 whitespace-nowrap">
                        {t('docker.colId')}
                      </th>
                      <th className="font-normal px-3 h-9 text-left w-24 whitespace-nowrap">
                        {t('docker.colSize')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {images.map(im => (
                      <tr
                        key={im.id}
                        className="border-b border-bd/50 hover:bg-hover"
                        onContextMenu={e => onImageCtx(e, im)}
                      >
                        <td className="px-3 h-9">
                          <span className="text-fg font-mono text-xs">{im.repository}</span>
                        </td>
                        <td className="px-3 h-9">
                          <span className="text-dim font-mono text-xs">{im.tag}</span>
                        </td>
                        <td className="px-3 h-9">
                          <span className="text-faint font-mono text-xs">{im.id}</span>
                        </td>
                        <td className="px-3 h-9">
                          <span className="text-dim font-mono text-xs">{im.size}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="shrink-0 px-3 h-7 flex items-center text-[11px] text-faint border-t border-bd/60">
              {t('docker.ctxHint')}
            </div>
          </div>
        ) : status === 'connecting' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-dim">
            <Spinner size={22} />
            <div className="text-xs">
              {t('term.connecting', { target: `${conn.host}:${conn.port}` })}
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="text-sm text-danger">{t('sftp.noSession')}</div>
            {connError && (
              <div className="text-xs text-faint max-w-md text-center break-all selectable">
                {connError}
              </div>
            )}
            <button
              onClick={() => void reconnect(tab.connectionId)}
              className="mt-1 text-xs text-accent hover:underline"
            >
              {t('term.reconnect')}
            </button>
          </div>
        )}

        {/* 操作遮罩 */}
        {opLabel && (
          <div className="absolute inset-0 bg-bg/50 flex flex-col items-center justify-center gap-2 z-20">
            <Spinner size={20} />
            <div className="text-xs text-dim">{opLabel}</div>
          </div>
        )}
      </div>

      {logTarget && sessionId && (
        <LogsModal
          sessionId={sessionId}
          container={logTarget}
          onClose={() => setLogTarget(null)}
        />
      )}
      {composeOpen && sessionId && (
        <ComposeModal
          sessionId={sessionId}
          onClose={() => setComposeOpen(false)}
          onStarted={load}
        />
      )}
    </div>
  )
}

/** 容器日志弹窗：支持快照查看与跟随（-f）流式输出 */
function LogsModal({
  sessionId,
  container,
  onClose,
}: {
  sessionId: string
  container: DockerContainer
  onClose: () => void
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [follow, setFollow] = useState(true)
  /** 全部日志：开启后不限制条数，否则只取最近 300 条 */
  const [all, setAll] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [nonce, setNonce] = useState(0)
  const streamIdRef = useRef<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // 流事件订阅（挂载一次）
  useEffect(() => {
    const offData = window.api.onSshStreamData((id, chunk) => {
      if (id === streamIdRef.current) setText(p => p + chunk)
    })
    const offClose = window.api.onSshStreamClose(id => {
      if (id === streamIdRef.current) {
        streamIdRef.current = null
        setStreaming(false)
      }
    })
    return () => {
      offData()
      offClose()
      if (streamIdRef.current) {
        window.api.sshStreamKill(streamIdRef.current)
        streamIdRef.current = null
      }
    }
  }, [])

  // follow / all 切换 / 手动刷新 → 重新拉取
  useEffect(() => {
    let cancelled = false
    setText('')
    const tailArg = all ? '' : ' --tail 300'
    if (follow) {
      setStreaming(true)
      window.api
        .sshExecStream(
          sessionId,
          `docker logs -f --timestamps${tailArg} ${shq(container.id)}`,
        )
        .then(sid => {
          if (cancelled) {
            window.api.sshStreamKill(sid)
            return
          }
          streamIdRef.current = sid
        })
        .catch(e => {
          if (!cancelled) void errorAlert(t('docker.logsFailed'), e)
        })
    } else {
      setStreaming(false)
      window.api
        .sshExec(sessionId, `docker logs --timestamps${tailArg} ${shq(container.id)}`)
        .then(res => {
          if (!cancelled) setText(res.stdout + res.stderr)
        })
        .catch(e => {
          if (!cancelled) void errorAlert(t('docker.logsFailed'), e)
        })
    }
    return () => {
      cancelled = true
      if (streamIdRef.current) {
        window.api.sshStreamKill(streamIdRef.current)
        streamIdRef.current = null
      }
    }
  }, [follow, all, nonce, sessionId, container.id, t])

  // 跟随模式自动滚动到底部
  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text, follow])

  return (
    <Modal
      open
      onClose={onClose}
      maskClosable={false}
      width={780}
      title={
        <span className="inline-flex items-center gap-2">
          <ScrollText size={15} className="text-accent" />
          {t('docker.logsTitle', { name: container.name })}
        </span>
      }
      footer={
        <div className="flex items-center gap-2.5 w-full">
          <span className="text-xs text-dim inline-flex items-center gap-2 select-none">
            <Switch checked={follow} onChange={setFollow} />
            {t('docker.follow')}
          </span>
          <span className="text-xs text-dim inline-flex items-center gap-2 select-none">
            <Switch checked={all} onChange={setAll} />
            {t('docker.allLogs')}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            icon={<RefreshCw size={13} />}
            onClick={() => setNonce(n => n + 1)}
          >
            {t('common.refresh')}
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <pre
        ref={preRef}
        className="bg-term-bg text-term-fg font-mono text-xs leading-relaxed rounded-md border border-bd p-3 h-[52vh] overflow-auto whitespace-pre-wrap break-all m-0"
      >
        {text || (streaming ? '' : t('common.loading'))}
      </pre>
    </Modal>
  )
}

/** Docker Compose 一键启动：远程浏览选择 compose 文件 → up -d（流式输出） */
function ComposeModal({
  sessionId,
  onClose,
  onStarted,
}: {
  sessionId: string
  onClose: () => void
  onStarted: () => void
}) {
  const t = useT()
  const [phase, setPhase] = useState<'pick' | 'run'>('pick')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FileInfo[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [output, setOutput] = useState('')
  const [code, setCode] = useState<number | null>(null)
  const streamIdRef = useRef<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  /** 浏览远程目录：只显示目录与 yml/yaml 文件 */
  const loadDir = useCallback(
    async (dir: string) => {
      if (!dir) return
      setBrowsing(true)
      try {
        const list = await window.api.sftpList(sessionId, dir)
        const filtered = list
          .filter(f => f.isDir || /\.ya?ml$/i.test(f.name))
          .sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
          )
        setEntries(filtered)
        setCwd(dir)
        setPathInput(dir)
        setSelected(null)
      } catch {
        message.error(t('docker.browseFailed'))
      } finally {
        setBrowsing(false)
      }
    },
    [sessionId, t],
  )

  // 初始定位到远程 home
  useEffect(() => {
    void (async () => {
      try {
        const h = await window.api.sftpHome(sessionId)
        await loadDir(h)
      } catch {
        /* 忽略：用户可手动输入路径 */
      }
    })()
  }, [sessionId, loadDir])

  // 运行阶段订阅流式输出
  useEffect(() => {
    if (phase !== 'run') return
    const offData = window.api.onSshStreamData((id, chunk) => {
      if (id === streamIdRef.current) setOutput(p => p + chunk)
    })
    const offClose = window.api.onSshStreamClose((id, c) => {
      if (id !== streamIdRef.current) return
      streamIdRef.current = null
      setCode(c)
      if (c === 0) {
        message.success(t('docker.composeDone'))
        onStarted()
      }
    })
    return () => {
      offData()
      offClose()
    }
  }, [phase, onStarted, t])

  // 输出自动滚动
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [output])

  const handleClose = () => {
    if (streamIdRef.current) {
      window.api.sshStreamKill(streamIdRef.current)
      streamIdRef.current = null
    }
    onClose()
  }

  /** 执行 compose up -d（优先 docker compose，回退 docker-compose） */
  const start = async (fileArg?: string) => {
    const file = fileArg ?? selected
    if (!file) return
    const dir = parentPath(file) ?? '/'
    const base = baseName(file)
    const cmd =
      `cd ${shq(dir)} && if docker compose version >/dev/null 2>&1; then ` +
      `docker compose -f ${shq(base)} up -d; else docker-compose -f ${shq(base)} up -d; fi`
    setPhase('run')
    setOutput('')
    setCode(null)
    try {
      const sid = await window.api.sshExecStream(sessionId, cmd)
      streamIdRef.current = sid
    } catch (e) {
      setCode(1)
      setOutput(e instanceof Error ? e.message : String(e))
    }
  }

  const up = parentPath(cwd)
  const iconBtn =
    'size-7 shrink-0 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-40'

  return (
    <Modal
      open
      onClose={handleClose}
      maskClosable={false}
      closable={phase === 'pick' || code !== null}
      width={680}
      title={
        <span className="inline-flex items-center gap-2">
          <Rocket size={15} className="text-accent" />
          {t('docker.composeTitle')}
        </span>
      }
      footer={
        phase === 'pick' ? (
          <>
            <Button onClick={handleClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!selected}
              icon={<Rocket size={14} />}
              onClick={() => void start()}
            >
              {t('docker.startBtn')}
            </Button>
          </>
        ) : (
          <>
            {code === null ? (
              <span className="text-xs text-dim inline-flex items-center gap-1.5 mr-auto">
                <Loader2 size={13} className="animate-spin" />
                {t('docker.running')}
              </span>
            ) : (
              <span
                className={`text-xs inline-flex items-center gap-1.5 mr-auto ${
                  code === 0 ? 'text-accent' : 'text-danger'
                }`}
              >
                {code === 0 ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                {code === 0 ? t('docker.composeDone') : t('docker.composeFailed')}
              </span>
            )}
            <Button onClick={handleClose}>{t('common.close')}</Button>
          </>
        )
      }
    >
      {phase === 'pick' ? (
        <div className="flex flex-col gap-2.5">
          <div className="text-xs text-dim leading-relaxed">{t('docker.composeHint')}</div>
          <div className="flex items-center gap-1.5">
            <Tooltip label={t('sftp.up')}>
              <button
                disabled={!up}
                onClick={() => up && void loadDir(up)}
                className={iconBtn}
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
              <button onClick={() => void loadDir(cwd)} className={iconBtn}>
                <RefreshCw size={14} className={browsing ? 'animate-spin' : ''} />
              </button>
            </Tooltip>
          </div>
          <div className="h-[38vh] overflow-auto rounded-md border border-bd bg-soft py-1">
            {browsing ? (
              <div className="flex items-center justify-center h-full text-dim gap-2">
                <Spinner size={16} />
                <span className="text-xs">{t('common.loading')}</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-faint px-4 text-center">
                {t('docker.noComposeFile')}
              </div>
            ) : (
              entries.map(f => (
                <div
                  key={f.path}
                  onClick={() => (f.isDir ? void loadDir(f.path) : setSelected(f.path))}
                  onDoubleClick={() => {
                    if (!f.isDir) {
                      setSelected(f.path)
                      void start(f.path)
                    }
                  }}
                  className={`mx-1 h-8 px-2.5 flex items-center gap-2 text-[13px] rounded-sm cursor-pointer ${
                    !f.isDir && selected === f.path
                      ? 'bg-accent-dim text-accent'
                      : 'text-fg hover:bg-hover'
                  }`}
                >
                  {f.isDir ? (
                    <Folder size={14} className="text-accent shrink-0" />
                  ) : (
                    <FileText size={14} className="text-warning shrink-0" />
                  )}
                  <span className="truncate">{f.name}</span>
                </div>
              ))
            )}
          </div>
          {selected && (
            <div className="text-xs text-dim font-mono truncate">
              {t('docker.selectedFile')}: {selected}
            </div>
          )}
        </div>
      ) : (
        <pre
          ref={preRef}
          className="bg-term-bg text-term-fg font-mono text-xs leading-relaxed rounded-md border border-bd p-3 h-[52vh] overflow-auto whitespace-pre-wrap break-all m-0"
        >
          {output}
        </pre>
      )}
    </Modal>
  )
}
