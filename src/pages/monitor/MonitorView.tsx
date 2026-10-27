import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Search,
  Skull,
} from 'lucide-react'
import type { SessionTab } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useT } from '../../i18n/I18nProvider'
import { Button, Input, Spinner, Tooltip, confirm, errorAlert, message } from '../../components/ui'
import { formatSize, formatSpeed } from '../../utils/files'

/** 一次采样的资源快照 */
interface Snapshot {
  cpu: number
  cpuCores: number
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  rxSpeed: number
  txSpeed: number
  load: string
  uptime: string
  disks: { fs: string; mount: string; total: number; used: number }[]
  procs: ProcInfo[]
}

interface ProcInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  rss: number
  stat: string
  etime: string
  cmd: string
}

/** 图表历史点 */
interface Sample {
  cpu: number
  mem: number
  rx: number
  tx: number
}

/** 采样命令：以 @@@ 标记切分各段，单次 SSH 往返取全量数据 */
const SAMPLE_CMD = [
  "printf '@@@STAT\\n'",
  'head -1 /proc/stat',
  "printf '@@@LOAD\\n'",
  'cat /proc/loadavg; grep "model name" /proc/cpuinfo | wc -l',
  "printf '@@@MEM\\n'",
  "grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo",
  "printf '@@@NET\\n'",
  'cat /proc/net/dev',
  "printf '@@@DF\\n'",
  'df -P -k 2>/dev/null',
  "printf '@@@PS\\n'",
  'ps -eo pid,user,pcpu,pmem,rss,stat,etime,args --no-headers 2>/dev/null | head -n 400',
  "printf '@@@UP\\n'",
  "uptime | sed 's/^ *//'",
].join('; ')

/** 按 @@@ 标记把输出切分为段落 */
function splitSections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('@@@')) {
      cur = line.slice(3).trim()
      res[cur] = []
    } else if (cur) {
      res[cur].push(line)
    }
  }
  return res
}

/** 解析 /proc/stat 首个 cpu 行 → [busy, total] */
function parseCpu(line: string): [number, number] {
  const p = line.trim().split(/\s+/).slice(1).map(Number)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = p
  return [user + nice + system + irq + softirq + steal, user + nice + system + idle + iowait + irq + softirq + steal]
}

/** 解析 /proc/net/dev，返回 [rx, tx] 字节总数（跳过回环） */
function parseNet(lines: string[]): [number, number] {
  let rx = 0
  let tx = 0
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const name = line.slice(0, idx).trim()
    if (!name || name === 'lo') continue
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number)
    if (f.length < 9) continue
    rx += f[0] || 0
    tx += f[8] || 0
  }
  return [rx, tx]
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0
}

/** 曲线图（无坐标轴，靠渐变与折线表达趋势） */
function Sparkline({
  values,
  max,
  color,
}: {
  values: number[]
  max: number
  color: string
}) {
  if (values.length < 2) {
    return <div className="h-10 w-full bg-hover/40 rounded" />
  }
  const hi = Math.max(max, ...values, 1)
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100
      const y = 30 - Math.min(30, (v / hi) * 30)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-10 w-full">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** 水平占用条 */
function Bar({ value, danger = false }: { value: number; danger?: boolean }) {
  return (
    <div className="h-1.5 w-full bg-hover rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${
          danger || value >= 85 ? 'bg-danger' : value >= 60 ? 'bg-warning' : 'bg-accent'
        }`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

function Card({ icon, title, extra, children }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-elevated border border-bd rounded-lg p-3 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 text-xs text-dim">
        <span className="text-accent">{icon}</span>
        <span className="flex-1 truncate">{title}</span>
        {extra}
      </div>
      {children}
    </div>
  )
}

/** 监控面板：资源曲线 + 磁盘 + 进程管理 */
export function MonitorView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const status = useSessionStore(s => s.connSessions[tab.connectionId]?.status)
  const sshSessionId = useSessionStore(s => s.connSessions[tab.connectionId]?.sshSessionId ?? null)
  const connError = useSessionStore(s => s.connSessions[tab.connectionId]?.error)
  const reconnect = useSessionStore(s => s.reconnect)

  const sessionId = status === 'connected' ? sshSessionId : null

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [history, setHistory] = useState<Sample[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState(true)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<'cpu' | 'mem' | 'pid'>('cpu')
  const [sortDesc, setSortDesc] = useState(true)
  const [killing, setKilling] = useState(false)

  /** 上一次采样的原始量，用于计算 CPU / 网络增量 */
  const prevRef = useRef<{ busy: number; total: number; rx: number; tx: number; ts: number } | null>(null)
  const busyRef = useRef(false)

  const collect = useCallback(async () => {
    if (!sessionId || busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const res = await window.api.sshExec(sessionId, SAMPLE_CMD)
      const sec = splitSections(res.stdout)
      const statLine = (sec.STAT ?? []).find(l => l.startsWith('cpu'))
      if (!statLine) throw new Error(res.stderr.trim() || t('monitor.errParse'))

      const [busy, total] = parseCpu(statLine)
      const [rx, tx] = parseNet(sec.NET ?? [])
      const now = Date.now()
      const prev = prevRef.current
      const deltaTotal = prev ? total - prev.total : 0
      const cpu = prev && deltaTotal > 0 ? ((busy - prev.busy) / deltaTotal) * 100 : 0
      let rxSpeed = 0
      let txSpeed = 0
      if (prev) {
        const dt = (now - prev.ts) / 1000
        if (dt > 0) {
          rxSpeed = Math.max(0, (rx - prev.rx) / dt)
          txSpeed = Math.max(0, (tx - prev.tx) / dt)
        }
      }
      prevRef.current = { busy, total, rx, tx, ts: now }

      const mem: Record<string, number> = {}
      for (const line of sec.MEM ?? []) {
        const m = line.match(/^(\w+):\s+(\d+)/)
        if (m) mem[m[1]] = Number(m[2])
      }
      const memTotal = (mem.MemTotal ?? 0) * 1024
      const memAvailable = mem.MemAvailable ?? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0)
      const memUsed = Math.max(0, memTotal - memAvailable * 1024)
      const swapTotal = (mem.SwapTotal ?? 0) * 1024
      const swapUsed = Math.max(0, swapTotal - (mem.SwapFree ?? 0) * 1024)

      const disks: Snapshot['disks'] = []
      for (const line of sec.DF ?? []) {
        const p = line.trim().split(/\s+/)
        if (p.length < 6 || p[0] === 'Filesystem') continue
        const totalKB = Number(p[1])
        const usedKB = Number(p[2])
        if (!Number.isFinite(totalKB) || totalKB <= 0) continue
        disks.push({ fs: p[0], total: totalKB * 1024, used: usedKB * 1024, mount: p[5] })
      }

      const procs: ProcInfo[] = []
      for (const line of sec.PS ?? []) {
        const s = line.trim()
        if (!s) continue
        const p = s.split(/\s+/)
        if (p.length < 8) continue
        procs.push({
          pid: Number(p[0]),
          user: p[1],
          cpu: Number(p[2]),
          mem: Number(p[3]),
          rss: Number(p[4]) * 1024,
          stat: p[5],
          etime: p[6],
          cmd: p.slice(7).join(' '),
        })
      }

      const loadLine = (sec.LOAD ?? [])[0] ?? ''
      const loadFields = loadLine.trim().split(/\s+/)
      const cores = Number((sec.LOAD ?? [])[1]) || 0
      const uptimeLine = (sec.UP ?? []).join(' ').trim()

      const next: Snapshot = {
        cpu: Math.round(cpu * 10) / 10,
        cpuCores: cores,
        memTotal,
        memUsed,
        swapTotal,
        swapUsed,
        rxSpeed,
        txSpeed,
        load: loadFields.length >= 3 ? `${loadFields[0]} ${loadFields[1]} ${loadFields[2]}` : '-',
        uptime: uptimeLine.replace(/^up\s+/, ''),
        disks,
        procs,
      }
      setSnap(next)
      setError(null)
      setHistory(h => [
        ...h.slice(-59),
        {
          cpu: next.cpu,
          mem: pct(next.memUsed, next.memTotal),
          rx: next.rxSpeed,
          tx: next.txSpeed,
        },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }, [sessionId, t])

  useEffect(() => {
    if (!sessionId) return
    void collect()
    if (!live) return
    const timer = window.setInterval(() => void collect(), 2000)
    return () => window.clearInterval(timer)
  }, [sessionId, live, collect])

  /** 连接切换后清空历史，避免曲线串台 */
  useEffect(() => {
    prevRef.current = null
    setSnap(null)
    setHistory([])
    setError(null)
  }, [sessionId])

  const procs = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (snap?.procs ?? []).filter(
      p => !q || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q,
    )
    const mul = sortDesc ? -1 : 1
    return list.sort((a, b) => {
      const av = sortKey === 'pid' ? a.pid : a[sortKey]
      const bv = sortKey === 'pid' ? b.pid : b[sortKey]
      return (av - bv) * mul
    })
  }, [snap, query, sortKey, sortDesc])

  const toggleSort = (k: 'cpu' | 'mem' | 'pid') => {
    if (sortKey === k) setSortDesc(v => !v)
    else {
      setSortKey(k)
      setSortDesc(true)
    }
  }

  const killProc = useCallback(
    async (p: ProcInfo) => {
      if (!sessionId) return
      const ok = await confirm({
        title: t('monitor.killTitle'),
        content: t('monitor.killConfirm', { pid: p.pid, cmd: p.cmd }),
        danger: true,
      })
      if (!ok) return
      setKilling(true)
      try {
        const res = await window.api.sshExec(sessionId, `kill -TERM ${p.pid} 2>&1 || kill -KILL ${p.pid}`)
        if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `exit ${res.code}`)
        message.success(t('monitor.killed', { pid: p.pid }))
        void collect()
      } catch (e) {
        await errorAlert(t('monitor.killFailed'), e)
      } finally {
        setKilling(false)
      }
    },
    [sessionId, t, collect],
  )

  if (!conn) return null

  const cpuHistory = history.map(h => h.cpu)
  const memHistory = history.map(h => h.mem)
  const rxHistory = history.map(h => h.rx)
  const txHistory = history.map(h => h.tx)
  const netMax = Math.max(0, ...rxHistory, ...txHistory)

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <span className="text-xs text-dim font-mono inline-flex items-center min-w-0">
          <Activity size={13} className="mr-1.5 text-accent shrink-0" />
          <span className="text-accent truncate">
            {conn.username}@{conn.host}
          </span>
          <span className="text-faint shrink-0">&nbsp;· monitor</span>
        </span>
        {snap && (
          <span className="text-[11px] text-faint truncate hidden md:inline">
            {t('monitor.load')} {snap.load}
            {snap.cpuCores > 0 ? ` · ${snap.cpuCores} cores` : ''}
            {snap.uptime ? ` · ${snap.uptime}` : ''}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setLive(v => !v)}
          className={`text-[11px] px-2 h-6 rounded-md transition-colors ${
            live ? 'bg-accent-dim text-accent' : 'text-dim hover:text-fg hover:bg-hover'
          }`}
        >
          {live ? t('monitor.liveOn') : t('monitor.liveOff')}
        </button>
        <Tooltip placement="bottom" label={t('common.refresh')}>
          <button
            onClick={() => void collect()}
            disabled={!sessionId || loading}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-40"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
      </div>

      {/* 内容 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {!sessionId ? (
          <div className="h-full flex flex-col items-center justify-center gap-3">
            {status === 'connecting' ? (
              <>
                <Spinner size={22} />
                <div className="text-xs text-dim">
                  {t('term.connecting', { target: `${conn.host}:${conn.port}` })}
                </div>
              </>
            ) : (
              <>
                <div className="text-sm text-danger">{t('sftp.noSession')}</div>
                {connError && (
                  <div className="text-xs text-faint max-w-md text-center break-all selectable">
                    {connError}
                  </div>
                )}
                <button
                  onClick={() => void reconnect(tab.connectionId)}
                  className="text-xs text-accent hover:underline"
                >
                  {t('term.reconnect')}
                </button>
              </>
            )}
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
            <Activity size={28} strokeWidth={1.5} className="text-faint" />
            <div className="text-sm text-danger">{t('monitor.errRead')}</div>
            <div className="text-xs text-dim max-w-md selectable break-all">{error}</div>
            <Button size="sm" className="mt-1" onClick={() => void collect()}>
              {t('common.refresh')}
            </Button>
          </div>
        ) : !snap ? (
          <div className="h-full flex items-center justify-center gap-2 text-dim">
            <Spinner size={18} />
            <span className="text-xs">{t('common.loading')}</span>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-3 flex flex-col gap-3">
            {/* 概览卡片 */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <Card
                icon={<Cpu size={14} />}
                title={t('monitor.cpu')}
                extra={<span className="text-fg tabular-nums">{snap.cpu.toFixed(1)}%</span>}
              >
                <Sparkline values={cpuHistory} max={100} color="var(--color-accent)" />
              </Card>
              <Card
                icon={<MemoryStick size={14} />}
                title={t('monitor.mem')}
                extra={
                  <span className="text-fg tabular-nums">
                    {formatSize(snap.memUsed)} / {formatSize(snap.memTotal)}
                  </span>
                }
              >
                <Sparkline values={memHistory} max={100} color="var(--color-warning)" />
              </Card>
              <Card
                icon={<HardDrive size={14} />}
                title={t('monitor.swap')}
                extra={
                  <span className="text-fg tabular-nums">
                    {snap.swapTotal > 0
                      ? `${formatSize(snap.swapUsed)} / ${formatSize(snap.swapTotal)}`
                      : t('monitor.swapNone')}
                  </span>
                }
              >
                <Bar value={pct(snap.swapUsed, snap.swapTotal)} />
                <div className="text-[11px] text-faint">
                  {snap.swapTotal > 0
                    ? `${pct(snap.swapUsed, snap.swapTotal).toFixed(0)}%`
                    : t('monitor.swapNoneHint')}
                </div>
              </Card>
              <Card
                icon={<Network size={14} />}
                title={t('monitor.net')}
                extra={
                  <span className="text-[11px] text-dim tabular-nums">
                    <ArrowDown size={11} className="inline text-info" /> {formatSpeed(snap.rxSpeed)}
                    <ArrowUp size={11} className="inline ml-1.5 text-accent" /> {formatSpeed(snap.txSpeed)}
                  </span>
                }
              >
                <Sparkline values={[...rxHistory, ...txHistory]} max={netMax} color="var(--color-info)" />
              </Card>
            </div>

            {/* 磁盘 */}
            <div className="bg-elevated border border-bd rounded-lg p-3">
              <div className="flex items-center gap-2 text-xs text-dim mb-2">
                <HardDrive size={14} className="text-accent" />
                <span>{t('monitor.disks')}</span>
              </div>
              {snap.disks.length === 0 ? (
                <div className="text-xs text-faint py-1">{t('common.empty')}</div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-2">
                  {snap.disks.map(d => {
                    const p = pct(d.used, d.total)
                    return (
                      <div key={`${d.fs}-${d.mount}`} className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-2 text-[12px]">
                          <span className="text-fg font-mono truncate max-w-[160px]" title={d.fs}>
                            {d.mount}
                          </span>
                          <span className="flex-1" />
                          <span className="text-dim tabular-nums shrink-0">
                            {formatSize(d.used)} / {formatSize(d.total)}
                          </span>
                          <span className="text-faint tabular-nums w-10 text-right shrink-0">
                            {p.toFixed(0)}%
                          </span>
                        </div>
                        <Bar value={p} />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 进程 */}
            <div className="flex-1 min-h-[260px] flex flex-col bg-elevated border border-bd rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 h-9 border-b border-bd shrink-0">
                <span className="text-xs text-dim">{t('monitor.processes')}</span>
                <span className="text-[11px] text-faint">{procs.length}</span>
                <div className="flex-1" />
                <div className="w-56 relative">
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
                  <Input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={t('monitor.searchPh')}
                    className="pl-7"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead className="sticky top-0 bg-elevated z-10">
                    <tr className="text-dim border-b border-bd">
                      <th
                        onClick={() => toggleSort('pid')}
                        className="font-normal px-3 h-8 text-left w-16 cursor-pointer select-none"
                      >
                        PID{sortKey === 'pid' ? (sortDesc ? ' ↓' : ' ↑') : ''}
                      </th>
                      <th className="font-normal px-2 h-8 text-left w-24">{t('monitor.user')}</th>
                      <th
                        onClick={() => toggleSort('cpu')}
                        className="font-normal px-2 h-8 text-right w-16 cursor-pointer select-none"
                      >
                        CPU%{sortKey === 'cpu' ? (sortDesc ? ' ↓' : ' ↑') : ''}
                      </th>
                      <th
                        onClick={() => toggleSort('mem')}
                        className="font-normal px-2 h-8 text-right w-16 cursor-pointer select-none"
                      >
                        MEM%{sortKey === 'mem' ? (sortDesc ? ' ↓' : ' ↑') : ''}
                      </th>
                      <th className="font-normal px-2 h-8 text-right w-20">{t('monitor.rss')}</th>
                      <th className="font-normal px-2 h-8 text-left w-16">{t('monitor.stat')}</th>
                      <th className="font-normal px-2 h-8 text-left w-20">{t('monitor.etime')}</th>
                      <th className="font-normal px-2 h-8 text-left">{t('monitor.command')}</th>
                      <th className="font-normal px-2 h-8 w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {procs.map(p => (
                      <tr key={p.pid} className="border-b border-bd/40 hover:bg-hover">
                        <td className="px-3 h-8 text-dim tabular-nums">{p.pid}</td>
                        <td className="px-2 h-8 text-dim truncate max-w-[96px]" title={p.user}>
                          {p.user}
                        </td>
                        <td className="px-2 h-8 text-right tabular-nums text-fg">{p.cpu.toFixed(1)}</td>
                        <td className="px-2 h-8 text-right tabular-nums text-fg">{p.mem.toFixed(1)}</td>
                        <td className="px-2 h-8 text-right tabular-nums text-dim">{formatSize(p.rss)}</td>
                        <td className="px-2 h-8 text-dim">{p.stat}</td>
                        <td className="px-2 h-8 text-dim tabular-nums">{p.etime}</td>
                        <td className="px-2 h-8 text-dim truncate max-w-[420px]" title={p.cmd}>
                          {p.cmd}
                        </td>
                        <td className="px-2 h-8">
                          <Tooltip label={t('monitor.kill')}>
                            <button
                              onClick={() => void killProc(p)}
                              disabled={killing || p.pid <= 1}
                              className="size-6 flex items-center justify-center rounded text-dim hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-30"
                            >
                              <Skull size={13} />
                            </button>
                          </Tooltip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {procs.length === 0 && (
                  <div className="text-xs text-faint text-center py-6">
                    {query ? t('sidebar.noResults') : t('common.empty')}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
