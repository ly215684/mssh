import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileCode,
  Folder,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'
import type { FileInfo, SessionTab } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useT } from '../../i18n/I18nProvider'
import { parentPath } from '../../utils/files'
import {
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Spinner,
  Tooltip,
  confirm,
  errorAlert,
  message,
  useContextMenu,
  type MenuItem,
} from '../../components/ui'

/** 解析后的定时任务 */
interface CronJob {
  id: string
  /** 该任务占用的起始行（含前置注释块），end 为结束行（不含） */
  start: number
  end: number
  /** 任务备注（前置注释行内容，可多行） */
  comment: string
  /** 调度表达式（5 字段或 @reboot 等特殊表达式） */
  schedule: string
  /** 命令 */
  command: string
  enabled: boolean
}

/** 常用调度预设（key → cron 表达式） */
const SCHEDULE_PRESETS: Record<string, string> = {
  minutely: '* * * * *',
  hourly: '@hourly',
  daily: '@daily',
  weekly: '@weekly',
  monthly: '@monthly',
  reboot: '@reboot',
}

/** 是否为合法的调度表达式（5 字段或 @特殊表达式） */
function validSchedule(s: string): boolean {
  const v = s.trim()
  if (!v) return false
  if (v.startsWith('@')) return /^@[a-z]+$/i.test(v)
  const fields = v.split(/\s+/)
  return fields.length === 5 && fields.every(f => /^[\d*/,?-]+$/.test(f))
}

/** 判断一行（去掉注释后）是否像任务行 */
function looksLikeJob(body: string): boolean {
  const tokens = body.trim().split(/\s+/)
  if (tokens.length < 2) return false
  if (tokens[0].startsWith('@')) return validSchedule(tokens[0])
  if (tokens.length < 6) return false
  return tokens.slice(0, 5).every(f => /^[\d*/,?-]+$/.test(f))
}

/** 解析任务行为 schedule + command */
function parseJobLine(body: string): { schedule: string; command: string } {
  const tokens = body.trim().split(/\s+/)
  if (tokens[0].startsWith('@')) {
    return { schedule: tokens[0], command: tokens.slice(1).join(' ') }
  }
  return { schedule: tokens.slice(0, 5).join(' '), command: tokens.slice(5).join(' ') }
}

/** 解析 crontab 文本 → 任务列表（环境变量等非任务行原样保留在行数组中） */
function parseCrontab(raw: string): { jobs: CronJob[]; lines: string[] } {
  const lines = raw.replace(/\r/g, '').split('\n')
  // 去掉末尾由输出产生的空行
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()

  const jobs: CronJob[] = []
  /** 未归属任务的注释行（start, 去掉 # 后的内容） */
  let pending: { start: number; text: string }[] = []

  const flushPlain = () => {
    // 未关联到任务的注释行原样保留（不属于任何 job 的占用区间）
    pending = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      flushPlain()
      i++
      continue
    }

    if (trimmed.startsWith('#')) {
      const body = trimmed.replace(/^#+\s*/, '')
      if (body && looksLikeJob(body)) {
        // 被禁用的任务行
        const { schedule, command } = parseJobLine(body)
        const commentStart = pending.length ? pending[0].start : i
        jobs.push({
          id: `${commentStart}`,
          start: commentStart,
          end: i + 1,
          comment: pending.map(p => p.text).join('\n'),
          schedule,
          command,
          enabled: false,
        })
        pending = []
        i++
        continue
      }
      pending.push({ start: i, text: body })
      i++
      continue
    }

    // 环境变量行（MAILTO=... 等）原样保留
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) {
      flushPlain()
      i++
      continue
    }

    // 启用中的任务行
    if (looksLikeJob(trimmed)) {
      const { schedule, command } = parseJobLine(trimmed)
      const commentStart = pending.length ? pending[0].start : i
      jobs.push({
        id: `${commentStart}`,
        start: commentStart,
        end: i + 1,
        comment: pending.map(p => p.text).join('\n'),
        schedule,
        command,
        enabled: true,
      })
      pending = []
      i++
      continue
    }

    flushPlain()
    i++
  }

  return { jobs, lines }
}

/** 由任务列表 + 原始行重建 crontab 内容（新任务追加到末尾） */
function serializeCrontab(lines: string[], nextJobs: CronJob[]): string {
  const out: string[] = []
  let i = 0
  for (const j of nextJobs) {
    if (j.id.startsWith('new')) continue
    while (i < j.start && i < lines.length) out.push(lines[i++])
    i = j.end
    if (j.comment.trim()) {
      for (const c of j.comment.split('\n')) out.push(`# ${c}`)
    }
    const jobLine = j.enabled ? `${j.schedule} ${j.command}` : `# ${j.schedule} ${j.command}`
    out.push(jobLine)
  }
  while (i < lines.length) out.push(lines[i++])
  for (const j of nextJobs) {
    if (!j.id.startsWith('new')) continue
    if (j.comment.trim()) {
      for (const c of j.comment.split('\n')) out.push(`# ${c}`)
    }
    out.push(`${j.schedule} ${j.command}`)
  }
  return out.join('\n')
}

/** 写回 crontab：base64 编码规避引号/换行问题，写入后立即校验 */
async function writeCrontab(sessionId: string, content: string): Promise<void> {
  const b64 = btoa(unescape(encodeURIComponent(content)))
  const res = await window.api.sshExec(
    sessionId,
    `echo '${b64}' | base64 -d | crontab - && crontab -l >/dev/null`,
  )
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || 'crontab write failed').trim())
  }
}

/** 任务显示名：备注优先，其次命令 */
function jobName(j: CronJob): string {
  return j.comment.trim() ? j.comment.split('\n')[0] : j.command
}

/** shell 单引号安全包裹 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 可识别为脚本的常见后缀 */
const SCRIPT_EXTS = /\.(sh|bash|zsh|py|pl|php|js|mjs|rb|lua)$/i

/** 由脚本路径生成默认执行命令（按后缀选择解释器，其余直接执行） */
function scriptCommand(p: string): string {
  if (/\.(sh|bash|zsh)$/i.test(p)) return `bash ${shq(p)}`
  if (/\.py$/i.test(p)) return `python3 ${shq(p)}`
  if (/\.pl$/i.test(p)) return `perl ${shq(p)}`
  if (/\.php$/i.test(p)) return `php ${shq(p)}`
  if (/\.(js|mjs)$/i.test(p)) return `node ${shq(p)}`
  if (/\.rb$/i.test(p)) return `ruby ${shq(p)}`
  if (/\.lua$/i.test(p)) return `lua ${shq(p)}`
  return shq(p)
}

/** 定时任务管理标签页：crontab 列表 + 新建 / 编辑 / 删除 / 启停 */
export function CronView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const status = useSessionStore(s => s.connSessions[tab.connectionId]?.status)
  const sshSessionId = useSessionStore(
    s => s.connSessions[tab.connectionId]?.sshSessionId ?? null,
  )
  const connError = useSessionStore(s => s.connSessions[tab.connectionId]?.error)
  const reconnect = useSessionStore(s => s.reconnect)
  const { openContextMenu } = useContextMenu()

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cronErr, setCronErr] = useState<string | null>(null)
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [rawLines, setRawLines] = useState<string[]>([])
  /** 编辑 / 新建弹窗 */
  const [editing, setEditing] = useState<CronJob | null>(null)
  const [isNew, setIsNew] = useState(false)

  const sessionId = status === 'connected' ? sshSessionId : null

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setCronErr(null)
    try {
      const res = await window.api.sshExec(sessionId, 'crontab -l')
      if (res.code !== 0 && /no crontab for/i.test(res.stderr)) {
        setJobs([])
        setRawLines([])
        return
      }
      if (res.code !== 0) {
        throw new Error((res.stderr || res.stdout || 'crontab -l failed').trim())
      }
      const { jobs, lines } = parseCrontab(res.stdout)
      setJobs(jobs)
      setRawLines(lines)
    } catch (e) {
      setCronErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (sessionId) void load()
  }, [sessionId, load])

  /** 保存任务（新建 / 编辑） */
  const saveJob = useCallback(
    async (job: CronJob) => {
      if (!sessionId) return
      let next: CronJob[]
      if (job.id.startsWith('new')) {
        next = [...jobs, job]
      } else {
        next = jobs.map(j => (j.id === job.id ? job : j))
      }
      setSaving(true)
      try {
        await writeCrontab(sessionId, serializeCrontab(rawLines, next))
        message.success(t('cron.saved'))
        setEditing(null)
        void load()
      } catch (e) {
        await errorAlert(t('cron.errWrite'), e)
      } finally {
        setSaving(false)
      }
    },
    [sessionId, jobs, rawLines, load, t],
  )

  /** 删除任务 */
  const removeJob = useCallback(
    async (job: CronJob) => {
      if (!sessionId) return
      const ok = await confirm({
        title: t('cron.deleteTitle'),
        content: t('cron.deleteConfirm', { name: jobName(job) }),
        danger: true,
      })
      if (!ok) return
      const next = jobs.filter(j => j.id !== job.id)
      setSaving(true)
      try {
        await writeCrontab(sessionId, serializeCrontab(rawLines, next))
        message.success(t('cron.deleteDone'))
        void load()
      } catch (e) {
        await errorAlert(t('cron.errWrite'), e)
      } finally {
        setSaving(false)
      }
    },
    [sessionId, jobs, rawLines, load, t],
  )

  /** 启用 / 禁用任务 */
  const toggleJob = useCallback(
    async (job: CronJob) => {
      if (!sessionId) return
      const next = jobs.map(j => (j.id === job.id ? { ...j, enabled: !j.enabled } : j))
      setSaving(true)
      try {
        await writeCrontab(sessionId, serializeCrontab(rawLines, next))
        message.success(t(job.enabled ? 'cron.disableDone' : 'cron.enableDone'))
        void load()
      } catch (e) {
        await errorAlert(t('cron.errWrite'), e)
      } finally {
        setSaving(false)
      }
    },
    [sessionId, jobs, rawLines, load, t],
  )

  /** 任务行右键菜单 */
  const onRowCtx = useCallback(
    (e: ReactMouseEvent, j: CronJob) => {
      const items: MenuItem[] = [
        { key: 'edit', label: t('common.edit'), icon: <Pencil size={14} /> },
        j.enabled
          ? { key: 'disable', label: t('cron.disable'), icon: <Square size={14} />, danger: true }
          : { key: 'enable', label: t('cron.enable'), icon: <Play size={14} /> },
        { key: 'divider', label: '', divider: true },
        { key: 'delete', label: t('common.delete'), icon: <Trash2 size={14} />, danger: true },
      ]
      openContextMenu(e, items, key => {
        if (key === 'edit') {
          setIsNew(false)
          setEditing({ ...j })
        } else if (key === 'delete') {
          void removeJob(j)
        } else if (key === 'enable' || key === 'disable') {
          void toggleJob(j)
        }
      })
    },
    [openContextMenu, t, removeJob, toggleJob],
  )

  const openNew = () => {
    setIsNew(true)
    setEditing({ id: 'new', start: 0, end: 0, comment: '', schedule: '* * * * *', command: '', enabled: true })
  }

  if (!conn) return null

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <span className="text-xs text-dim font-mono inline-flex items-center">
          <Clock size={13} className="mr-1.5 text-accent" />
          <span className="text-accent">
            {conn.username}@{conn.host}
          </span>
          <span className="text-faint">&nbsp;· crontab</span>
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!sessionId || saving}
          onClick={openNew}
        >
          {t('cron.add')}
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
            <div className="flex-1 min-h-0 overflow-auto">
              {loading && jobs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-dim gap-2">
                  <Spinner size={18} />
                  <span className="text-xs">{t('common.loading')}</span>
                </div>
              ) : cronErr ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                  <Clock size={28} strokeWidth={1.5} className="text-faint" />
                  <div className="text-sm text-danger">{t('cron.errRead')}</div>
                  <div className="text-xs text-dim max-w-md selectable break-all">{cronErr}</div>
                  <Button size="sm" className="mt-1" onClick={() => void load()}>
                    {t('common.refresh')}
                  </Button>
                </div>
              ) : jobs.length === 0 ? (
                <Empty icon={<Clock size={30} strokeWidth={1.5} />} text={t('cron.noJobs')} />
              ) : (
                <table className="w-full text-[13px] border-collapse">
                  <thead className="sticky top-0 bg-bg z-10">
                    <tr className="text-dim border-b border-bd">
                      <th className="font-normal px-3 h-9 text-left whitespace-nowrap">
                        {t('cron.colName')}
                      </th>
                      <th className="font-normal px-3 h-9 text-left w-36 whitespace-nowrap">
                        {t('cron.colSchedule')}
                      </th>
                      <th className="font-normal px-3 h-9 text-left whitespace-nowrap">
                        {t('cron.colCommand')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map(j => (
                      <tr
                        key={j.id}
                        onContextMenu={e => onRowCtx(e, j)}
                        onDoubleClick={() => {
                          setIsNew(false)
                          setEditing({ ...j })
                        }}
                        className="border-b border-bd/50 hover:bg-hover"
                      >
                        <td className="px-3 h-9">
                          <span className="inline-flex items-center gap-2">
                            <span
                              className={`size-2 rounded-full shrink-0 ${
                                j.enabled ? 'bg-accent' : 'bg-faint'
                              }`}
                            />
                            <span className={`max-w-[220px] truncate inline-block align-middle ${j.enabled ? 'text-fg' : 'text-faint line-through'}`}>
                              {jobName(j)}
                            </span>
                          </span>
                        </td>
                        <td className="px-3 h-9">
                          <span className="text-dim font-mono text-xs whitespace-nowrap">
                            {j.schedule}
                          </span>
                        </td>
                        <td className="px-3 h-9">
                          <span className="text-dim font-mono text-xs max-w-[420px] truncate inline-block align-middle">
                            {j.command}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="shrink-0 px-3 h-7 flex items-center text-[11px] text-faint border-t border-bd/60">
              {t('cron.ctxHint')}
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
      </div>

      {editing && sessionId && (
        <JobModal
          key={editing.id}
          sessionId={sessionId}
          job={editing}
          isNew={isNew}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={saveJob}
        />
      )}
    </div>
  )
}

/** 新建 / 编辑任务弹窗（edit = 表单 / pick = 远程选择脚本） */
function JobModal({
  sessionId,
  job,
  isNew,
  saving,
  onClose,
  onSave,
}: {
  sessionId: string
  job: CronJob
  isNew: boolean
  saving: boolean
  onClose: () => void
  onSave: (job: CronJob) => Promise<void>
}) {
  const t = useT()
  const [comment, setComment] = useState(job.comment)
  const [schedule, setSchedule] = useState(job.schedule)
  const [command, setCommand] = useState(job.command)
  const [phase, setPhase] = useState<'edit' | 'pick'>('edit')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FileInfo[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')

  /** 预设值：当前表达式匹配则高亮，否则为 custom */
  const presetValue =
    Object.entries(SCHEDULE_PRESETS).find(([, v]) => v === schedule.trim())?.[0] ?? 'custom'

  /** 应用预设（自定义时不改动表达式） */
  const applyPreset = (v: string) => {
    if (v !== 'custom') setSchedule(SCHEDULE_PRESETS[v])
  }

  const submit = async () => {
    if (!validSchedule(schedule)) {
      await errorAlert(t('cron.errScheduleTitle'), t('cron.errSchedule'))
      return
    }
    if (!command.trim()) {
      await errorAlert(t('cron.errScheduleTitle'), t('cron.errCommand'))
      return
    }
    await onSave({
      ...job,
      comment: comment.trim(),
      schedule: schedule.trim(),
      command: command.trim(),
    })
  }

  /** 浏览远程目录：只显示目录与脚本 / 可执行文件 */
  const loadDir = useCallback(
    async (dir: string) => {
      if (!dir) return
      setBrowsing(true)
      try {
        const list = await window.api.sftpList(sessionId, dir)
        const filtered = list
          .filter(
            f =>
              f.isDir ||
              SCRIPT_EXTS.test(f.name) ||
              (f.mode !== undefined && (f.mode & 0o111) !== 0),
          )
          .sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
          )
        setEntries(filtered)
        setCwd(dir)
        setPathInput(dir)
        setSelected(null)
      } catch {
        message.error(t('cron.browseFailed'))
      } finally {
        setBrowsing(false)
      }
    },
    [sessionId, t],
  )

  // 进入选择阶段 → 定位到远程 home
  useEffect(() => {
    if (phase !== 'pick') return
    void (async () => {
      try {
        const h = await window.api.sftpHome(sessionId)
        await loadDir(h)
      } catch {
        /* 忽略：用户可手动输入路径 */
      }
    })()
  }, [phase, sessionId, loadDir])

  /** 使用选中脚本：按后缀生成命令并回到编辑 */
  const applyScript = (p: string) => {
    setCommand(scriptCommand(p))
    setPhase('edit')
  }

  const up = parentPath(cwd)
  const iconBtn =
    'size-7 shrink-0 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-40'

  return (
    <Modal
      open
      onClose={onClose}
      maskClosable={false}
      width={phase === 'pick' ? 640 : 560}
      title={
        <span className="inline-flex items-center gap-2">
          <CalendarClock size={15} className="text-accent" />
          {phase === 'pick' ? t('cron.pickTitle') : isNew ? t('cron.newTitle') : t('cron.editTitle')}
        </span>
      }
      footer={
        phase === 'pick' ? (
          <>
            <Button onClick={() => setPhase('edit')}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!selected}
              icon={<FileCode size={14} />}
              onClick={() => selected && applyScript(selected)}
            >
              {t('cron.useScript')}
            </Button>
          </>
        ) : (
          <>
            {!isNew && (
              <span
                className={`text-xs inline-flex items-center gap-1.5 mr-auto ${
                  job.enabled ? 'text-accent' : 'text-faint'
                }`}
              >
                {job.enabled ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                {job.enabled ? t('cron.enabled') : t('cron.disabled')}
              </span>
            )}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {phase === 'pick' ? (
        <div className="flex flex-col gap-2.5">
          <div className="text-xs text-dim leading-relaxed">{t('cron.pickHint')}</div>
          <div className="flex items-center gap-1.5">
            <Tooltip label={t('sftp.up')}>
              <button disabled={!up} onClick={() => up && void loadDir(up)} className={iconBtn}>
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
                {t('cron.noScript')}
              </div>
            ) : (
              entries.map(f => (
                <div
                  key={f.path}
                  onClick={() => (f.isDir ? void loadDir(f.path) : setSelected(f.path))}
                  onDoubleClick={() => {
                    if (!f.isDir) applyScript(f.path)
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
                    <FileCode size={14} className="text-warning shrink-0" />
                  )}
                  <span className="truncate">{f.name}</span>
                </div>
              ))
            )}
          </div>
          {selected && (
            <div className="text-xs text-dim font-mono truncate">
              {t('cron.selectedFile')}: {selected}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-xs text-dim mb-1.5">{t('cron.name')}</div>
            <Input
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={t('cron.namePh')}
              spellCheck={false}
            />
          </div>
          <div>
            <div className="text-xs text-dim mb-1.5">{t('cron.schedule')}</div>
            <div className="flex gap-2">
              <div className="w-36 shrink-0">
                <Select value={presetValue} onChange={applyPreset} options={[
                  { value: 'minutely', label: t('cron.presetMinutely') },
                  { value: 'hourly', label: t('cron.presetHourly') },
                  { value: 'daily', label: t('cron.presetDaily') },
                  { value: 'weekly', label: t('cron.presetWeekly') },
                  { value: 'monthly', label: t('cron.presetMonthly') },
                  { value: 'reboot', label: t('cron.presetReboot') },
                  { value: 'custom', label: t('cron.presetCustom') },
                ]} />
              </div>
              <Input
                value={schedule}
                onChange={e => setSchedule(e.target.value)}
                placeholder={t('cron.schedulePh')}
                spellCheck={false}
                className="font-mono flex-1"
              />
            </div>
            <div className="text-[11px] text-faint mt-1.5">{t('cron.scheduleHint')}</div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs text-dim">{t('cron.command')}</div>
              <button
                type="button"
                onClick={() => setPhase('pick')}
                className="text-xs text-accent hover:underline inline-flex items-center gap-1"
              >
                <FileCode size={12} />
                {t('cron.pickScript')}
              </button>
            </div>
            <textarea
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder={t('cron.commandPh')}
              spellCheck={false}
              rows={3}
              className="w-full bg-input border border-bd rounded-md px-3 py-2 text-[13px] font-mono text-fg placeholder:text-faint outline-none focus:border-accent hover:border-bd-strong transition-colors resize-y min-h-[68px]"
            />
          </div>
        </div>
      )}
    </Modal>
  )
}
