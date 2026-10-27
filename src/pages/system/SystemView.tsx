import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  FileText,
  Package,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Shield,
  Square,
  Trash2,
} from 'lucide-react'
import type { SessionTab } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useT } from '../../i18n/I18nProvider'
import {
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Spinner,
  Tabs,
  Tooltip,
  confirm,
  errorAlert,
  message,
} from '../../components/ui'

type SysTab = 'services' | 'packages' | 'firewall'
type PkgManager = 'apt-get' | 'dnf' | 'yum' | 'apk' | 'pacman' | 'zypper'
type FirewallKind = 'ufw' | 'firewall-cmd' | 'nft' | 'iptables'

interface ServiceRow {
  unit: string
  load: string
  active: string
  sub: string
  desc: string
}

interface PkgRow {
  name: string
  version: string
}

interface UfwRule {
  num: number
  raw: string
}

/** POSIX 单引号包裹 */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 包管理器 → 安装 / 卸载 / 刷新索引命令 */
const PKG_CMD: Record<PkgManager, { install: string; remove: string; refresh: string }> = {
  'apt-get': {
    install: 'apt-get install -y',
    remove: 'apt-get remove -y',
    refresh: 'apt-get update',
  },
  dnf: { install: 'dnf install -y', remove: 'dnf remove -y', refresh: 'dnf makecache' },
  yum: { install: 'yum install -y', remove: 'yum remove -y', refresh: 'yum makecache' },
  apk: { install: 'apk add', remove: 'apk del', refresh: 'apk update' },
  pacman: {
    install: 'pacman -S --noconfirm',
    remove: 'pacman -Rns --noconfirm',
    refresh: 'pacman -Sy',
  },
  zypper: { install: 'zypper install -y', remove: 'zypper remove -y', refresh: 'zypper refresh' },
}

/** 执行一次 SSH 命令并要求退出码为 0 */
async function runOk(sessionId: string, cmd: string): Promise<string> {
  const res = await window.api.sshExec(sessionId, cmd)
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `exit ${res.code}`)
  return res.stdout
}

/** 系统管理面板：systemd 服务 / 软件包 / 防火墙 */
export function SystemView({ tab }: { tab: SessionTab }) {
  const t = useT()
  const conn = useConnStore(s => s.connections.find(c => c.id === tab.connectionId))
  const status = useSessionStore(s => s.connSessions[tab.connectionId]?.status)
  const sshSessionId = useSessionStore(s => s.connSessions[tab.connectionId]?.sshSessionId ?? null)
  const connError = useSessionStore(s => s.connSessions[tab.connectionId]?.error)
  const reconnect = useSessionStore(s => s.reconnect)

  const sessionId = status === 'connected' ? sshSessionId : null
  const [tabKey, setTabKey] = useState<SysTab>('services')
  const [sudo, setSudo] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [opLabel, setOpLabel] = useState<string | null>(null)

  /** 流式日志弹窗 */
  const [logReq, setLogReq] = useState<{ title: string; command: string; reload?: boolean } | null>(null)

  // ---- 服务 ----
  const [services, setServices] = useState<ServiceRow[]>([])
  const [svcAvailable, setSvcAvailable] = useState<boolean | null>(null)
  const [svcQuery, setSvcQuery] = useState('')

  // ---- 软件包 ----
  const [pm, setPm] = useState<PkgManager | null>(null)
  const [packages, setPackages] = useState<PkgRow[]>([])
  const [pkgQuery, setPkgQuery] = useState('')
  const [installName, setInstallName] = useState('')

  // ---- 防火墙 ----
  const [fw, setFw] = useState<FirewallKind | null>(null)
  const [fwText, setFwText] = useState('')
  const [ufwRules, setUfwRules] = useState<UfwRule[]>([])
  const [fwPort, setFwPort] = useState('')
  const [fwProto, setFwProto] = useState<'tcp' | 'udp'>('tcp')

  const runOp = useCallback(async (label: string, fn: () => Promise<void>) => {
    setOpLabel(label)
    try {
      await fn()
    } finally {
      setOpLabel(null)
    }
  }, [])

  /** 检测执行权限：root 直连，非 root 尝试免密 sudo */
  useEffect(() => {
    if (!sessionId) return
    void (async () => {
      try {
        const res = await window.api.sshExec(sessionId, 'id -u')
        setSudo(res.stdout.trim() === '0' ? '' : 'sudo -n ')
      } catch {
        setSudo('')
      }
    })()
  }, [sessionId])

  const loadServices = useCallback(async () => {
    if (!sessionId) return
    const res = await window.api.sshExec(
      sessionId,
      'command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null',
    )
    if (!res.stdout.trim()) {
      setSvcAvailable(false)
      setServices([])
      return
    }
    setSvcAvailable(true)
    const rows: ServiceRow[] = []
    for (const line of res.stdout.replace(/\r/g, '').split('\n')) {
      // 末尾的图例（"N loaded units listed."）跳过
      if (!line.trim() || /loaded units listed/.test(line)) continue
      const p = line.trim().split(/\s+/)
      if (p.length < 4) continue
      rows.push({
        unit: p[0].replace(/^[●*]\s*/, ''),
        load: p[1],
        active: p[2],
        sub: p[3],
        desc: p.slice(4).join(' '),
      })
    }
    setServices(rows)
  }, [sessionId])

  const loadPackages = useCallback(async () => {
    if (!sessionId) return
    const det = await window.api.sshExec(
      sessionId,
      'for c in apt-get dnf yum apk pacman zypper; do command -v $c >/dev/null 2>&1 && { echo $c; break; }; done',
    )
    const mgr = det.stdout.trim() as PkgManager
    if (!mgr) {
      setPm(null)
      setPackages([])
      return
    }
    setPm(mgr)
    let cmd = ''
    if (mgr === 'apt-get') cmd = "dpkg-query -W -f='${Package}\\t${Version}\\n' 2>/dev/null"
    else if (mgr === 'dnf' || mgr === 'yum' || mgr === 'zypper')
      cmd = "rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' 2>/dev/null"
    else if (mgr === 'apk') cmd = 'apk info -v 2>/dev/null'
    else if (mgr === 'pacman') cmd = 'pacman -Q 2>/dev/null'
    const res = await window.api.sshExec(sessionId, cmd)
    const rows: PkgRow[] = []
    for (const line of res.stdout.replace(/\r/g, '').split('\n')) {
      const s = line.trim()
      if (!s) continue
      const parts = s.split(/\s+/)
      if (!parts[0]) continue
      rows.push({ name: parts[0], version: parts.slice(1).join(' ') })
      if (rows.length >= 3000) break
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    setPackages(rows)
  }, [sessionId])

  const loadFirewall = useCallback(async () => {
    if (!sessionId) return
    const det = await window.api.sshExec(
      sessionId,
      'for c in ufw firewall-cmd nft iptables; do command -v $c >/dev/null 2>&1 && { echo $c; break; }; done',
    )
    const kind = det.stdout.trim() as FirewallKind
    if (!kind) {
      setFw(null)
      setFwText('')
      setUfwRules([])
      return
    }
    setFw(kind)
    if (kind === 'ufw') {
      const out = await runOk(sessionId, `${sudo}LC_ALL=C ufw status numbered 2>&1`)
      setFwText(out)
      const rules: UfwRule[] = []
      for (const line of out.split('\n')) {
        const m = line.match(/^\[\s*(\d+)\]\s+(.+)$/)
        if (m) rules.push({ num: Number(m[1]), raw: m[2].trim() })
      }
      setUfwRules(rules)
    } else if (kind === 'firewall-cmd') {
      setFwText(await runOk(sessionId, 'firewall-cmd --list-all 2>&1'))
    } else if (kind === 'nft') {
      setFwText(await runOk(sessionId, `${sudo}nft list ruleset 2>&1`))
    } else {
      setFwText(await runOk(sessionId, `${sudo}iptables -L -n --line-numbers 2>&1`))
    }
  }, [sessionId, sudo])

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setLoadError(null)
    try {
      if (tabKey === 'services') await loadServices()
      else if (tabKey === 'packages') await loadPackages()
      else await loadFirewall()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId, tabKey, loadServices, loadPackages, loadFirewall])

  useEffect(() => {
    if (sessionId) void load()
  }, [sessionId, load])

  /** 服务操作 */
  const svcAction = useCallback(
    async (unit: string, action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') => {
      if (!sessionId) return
      const label = t(`system.svc.op.${action}` as 'system.svc.op.start')
      await runOp(label, async () => {
        try {
          await runOk(sessionId, `${sudo}systemctl ${action} ${q(unit)} 2>&1`)
          message.success(t('system.svc.done', { name: unit }))
          await loadServices()
        } catch (e) {
          await errorAlert(t('system.opFailed'), e)
        }
      })
    },
    [sessionId, sudo, runOp, t, loadServices],
  )

  const openServiceLog = (unit: string) => {
    if (!sessionId) return
    setLogReq({
      title: t('system.svc.logsTitle', { name: unit }),
      command: `journalctl -u ${q(unit)} -n 300 --no-pager 2>&1`,
    })
  }

  /** 安装软件包 */
  const installPkg = async () => {
    const name = installName.trim()
    if (!sessionId || !pm || !name) return
    setInstallName('')
    setLogReq({
      title: t('system.pkg.installTitle', { name }),
      command: `${sudo}${PKG_CMD[pm].install} ${q(name)} 2>&1`,
      reload: true,
    })
  }

  const removePkg = useCallback(
    async (name: string) => {
      if (!sessionId || !pm) return
      const ok = await confirm({
        title: t('system.pkg.removeTitle'),
        content: t('system.pkg.removeConfirm', { name }),
        danger: true,
      })
      if (!ok) return
      setLogReq({
        title: t('system.pkg.removeTitle'),
        command: `${sudo}${PKG_CMD[pm].remove} ${q(name)} 2>&1`,
        reload: true,
      })
    },
    [sessionId, pm, sudo, t],
  )

  const refreshIndex = async () => {
    if (!sessionId || !pm) return
    const ok = await confirm({
      title: t('system.pkg.refreshTitle'),
      content: t('system.pkg.refreshConfirm'),
    })
    if (!ok) return
    setLogReq({
      title: t('system.pkg.refreshTitle'),
      command: `${sudo}${PKG_CMD[pm].refresh} 2>&1`,
    })
  }

  /** 防火墙放行端口 */
  const allowPort = async () => {
    const port = Number(fwPort)
    if (!sessionId || !fw) return
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      await errorAlert(t('system.fw.invalidPort'), t('system.fw.invalidPortHint'))
      return
    }
    const ok = await confirm({
      title: t('system.fw.allowTitle'),
      content: t('system.fw.allowConfirm', { port, proto: fwProto }),
    })
    if (!ok) return
    let cmd: string
    if (fw === 'ufw') cmd = `${sudo}ufw allow ${port}/${fwProto} 2>&1`
    else if (fw === 'firewall-cmd')
      cmd = `${sudo}firewall-cmd --permanent --add-port=${port}/${fwProto} && ${sudo}firewall-cmd --reload 2>&1`
    else if (fw === 'nft')
      cmd = `${sudo}nft add rule inet filter input ${fwProto} dport ${port} accept 2>&1`
    else cmd = `${sudo}iptables -I INPUT -p ${fwProto} --dport ${port} -j ACCEPT 2>&1`
    await runOp(t('system.fw.applying'), async () => {
      try {
        await runOk(sessionId, cmd)
        message.success(t('system.fw.allowDone', { port }))
        setFwPort('')
        await loadFirewall()
      } catch (e) {
        await errorAlert(t('system.opFailed'), e)
      }
    })
  }

  const deleteUfwRule = async (rule: UfwRule) => {
    if (!sessionId) return
    const ok = await confirm({
      title: t('system.fw.deleteTitle'),
      content: t('system.fw.deleteConfirm', { rule: rule.raw }),
      danger: true,
    })
    if (!ok) return
    await runOp(t('system.fw.applying'), async () => {
      try {
        await runOk(sessionId, `${sudo}ufw --force delete ${rule.num} 2>&1`)
        message.success(t('system.fw.deleteDone'))
        await loadFirewall()
      } catch (e) {
        await errorAlert(t('system.opFailed'), e)
      }
    })
  }

  const filteredServices = useMemo(() => {
    const kw = svcQuery.trim().toLowerCase()
    if (!kw) return services
    return services.filter(
      s => s.unit.toLowerCase().includes(kw) || s.desc.toLowerCase().includes(kw),
    )
  }, [services, svcQuery])

  const filteredPackages = useMemo(() => {
    const kw = pkgQuery.trim().toLowerCase()
    if (!kw) return packages.slice(0, 500)
    return packages.filter(p => p.name.toLowerCase().includes(kw)).slice(0, 500)
  }, [packages, pkgQuery])

  if (!conn) return null

  const tabs = [
    { key: 'services' as const, label: t('system.tab.services'), icon: <Server size={14} /> },
    { key: 'packages' as const, label: t('system.tab.packages'), icon: <Package size={14} /> },
    { key: 'firewall' as const, label: t('system.tab.firewall'), icon: <Shield size={14} /> },
  ]

  const body = (
    <>
      {/* 工具行 */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-bd shrink-0">
        <span className="text-xs text-dim font-mono inline-flex items-center min-w-0">
          <Server size={13} className="mr-1.5 text-accent shrink-0" />
          <span className="text-accent truncate">
            {conn.username}@{conn.host}
          </span>
          <span className="text-faint shrink-0">&nbsp;· system</span>
        </span>
        <div className="flex-1" />
        <Tooltip placement="bottom" label={t('common.refresh')}>
          <button
            onClick={() => void load()}
            disabled={!sessionId || loading}
            className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-40"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
      </div>

      {/* 子标签 */}
      <div className="px-3 shrink-0">
        <Tabs items={tabs} active={tabKey} onChange={setTabKey} />
      </div>

      <div className="flex-1 min-h-0 relative">
        {!sessionId ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
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
        ) : loading && !services.length && !packages.length && !fwText ? (
          <div className="h-full flex items-center justify-center gap-2 text-dim">
            <Spinner size={18} />
            <span className="text-xs">{t('common.loading')}</span>
          </div>
        ) : loadError ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
            <Server size={28} strokeWidth={1.5} className="text-faint" />
            <div className="text-sm text-danger">{t('system.errRead')}</div>
            <div className="text-xs text-dim max-w-lg selectable break-all">{loadError}</div>
            <Button size="sm" className="mt-1" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
          </div>
        ) : tabKey === 'services' ? (
          svcAvailable === false ? (
            <Empty icon={<Server size={30} strokeWidth={1.5} />} text={t('system.svc.unavailable')} />
          ) : (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-3 h-10 border-b border-bd shrink-0">
                <div className="w-64 relative">
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
                  <Input
                    value={svcQuery}
                    onChange={e => setSvcQuery(e.target.value)}
                    placeholder={t('system.svc.searchPh')}
                    className="pl-7"
                  />
                </div>
                <span className="text-[11px] text-faint">
                  {filteredServices.length} / {services.length}
                </span>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead className="sticky top-0 bg-bg z-10">
                    <tr className="text-dim border-b border-bd">
                      <th className="font-normal px-3 h-8 text-left">{t('system.svc.unit')}</th>
                      <th className="font-normal px-2 h-8 text-left w-24">{t('system.svc.active')}</th>
                      <th className="font-normal px-2 h-8 text-left w-24">{t('system.svc.sub')}</th>
                      <th className="font-normal px-2 h-8 text-left">{t('system.svc.desc')}</th>
                      <th className="font-normal px-2 h-8 text-right w-44">{t('system.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredServices.map(s => {
                      const running = s.active === 'active'
                      return (
                        <tr key={s.unit} className="border-b border-bd/40 hover:bg-hover">
                          <td className="px-3 h-8 font-mono text-fg truncate max-w-[260px]" title={s.unit}>
                            {s.unit}
                          </td>
                          <td className="px-2 h-8">
                            <span className={running ? 'text-accent' : s.active === 'failed' ? 'text-danger' : 'text-dim'}>
                              {s.active}
                            </span>
                          </td>
                          <td className="px-2 h-8 text-dim">{s.sub}</td>
                          <td className="px-2 h-8 text-dim truncate max-w-[420px]" title={s.desc}>
                            {s.desc}
                          </td>
                          <td className="px-2 h-8">
                            <div className="flex items-center justify-end gap-0.5">
                              <SvcBtn
                                label={t('system.svc.start')}
                                disabled={running}
                                onClick={() => void svcAction(s.unit, 'start')}
                              >
                                <Play size={12} />
                              </SvcBtn>
                              <SvcBtn
                                label={t('system.svc.stop')}
                                disabled={!running}
                                onClick={() => void svcAction(s.unit, 'stop')}
                              >
                                <Square size={12} />
                              </SvcBtn>
                              <SvcBtn
                                label={t('system.svc.restart')}
                                onClick={() => void svcAction(s.unit, 'restart')}
                              >
                                <RotateCw size={12} />
                              </SvcBtn>
                              <SvcBtn
                                label={t('system.svc.enable')}
                                onClick={() => void svcAction(s.unit, 'enable')}
                              >
                                <Power size={12} />
                              </SvcBtn>
                              <SvcBtn label={t('system.svc.logs')} onClick={() => openServiceLog(s.unit)}>
                                <FileText size={12} />
                              </SvcBtn>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {filteredServices.length === 0 && (
                  <div className="text-xs text-faint text-center py-6">{t('common.empty')}</div>
                )}
              </div>
            </div>
          )
        ) : tabKey === 'packages' ? (
          pm === null ? (
            <Empty icon={<Package size={30} strokeWidth={1.5} />} text={t('system.pkg.unavailable')} />
          ) : (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-3 h-10 border-b border-bd shrink-0">
                <span className="text-[11px] text-faint shrink-0">{pm}</span>
                <div className="w-56 relative">
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
                  <Input
                    value={pkgQuery}
                    onChange={e => setPkgQuery(e.target.value)}
                    placeholder={t('system.pkg.searchPh')}
                    className="pl-7"
                  />
                </div>
                <div className="flex-1" />
                <div className="w-44">
                  <Input
                    value={installName}
                    onChange={e => setInstallName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void installPkg()
                    }}
                    placeholder={t('system.pkg.installPh')}
                  />
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!installName.trim()}
                  onClick={() => void installPkg()}
                >
                  {t('system.pkg.install')}
                </Button>
                <Tooltip placement="bottom" label={t('system.pkg.refreshIndex')}>
                  <button
                    onClick={() => void refreshIndex()}
                    className="size-7 flex items-center justify-center rounded-md text-dim hover:text-fg hover:bg-hover transition-colors"
                  >
                    <RefreshCw size={14} />
                  </button>
                </Tooltip>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead className="sticky top-0 bg-bg z-10">
                    <tr className="text-dim border-b border-bd">
                      <th className="font-normal px-3 h-8 text-left">{t('system.pkg.name')}</th>
                      <th className="font-normal px-2 h-8 text-left">{t('system.pkg.version')}</th>
                      <th className="font-normal px-2 h-8 text-right w-24">{t('system.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPackages.map(p => (
                      <tr key={p.name} className="border-b border-bd/40 hover:bg-hover">
                        <td className="px-3 h-8 font-mono text-fg truncate max-w-[320px]" title={p.name}>
                          {p.name}
                        </td>
                        <td className="px-2 h-8 text-dim font-mono truncate max-w-[320px]" title={p.version}>
                          {p.version || '-'}
                        </td>
                        <td className="px-2 h-8 text-right">
                          <SvcBtn label={t('system.pkg.remove')} onClick={() => void removePkg(p.name)}>
                            <Trash2 size={12} />
                          </SvcBtn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredPackages.length === 0 && (
                  <div className="text-xs text-faint text-center py-6">{t('common.empty')}</div>
                )}
                {!pkgQuery && packages.length > 500 && (
                  <div className="text-[11px] text-faint text-center pb-3">{t('system.pkg.truncated')}</div>
                )}
              </div>
            </div>
          )
        ) : fw === null ? (
          <Empty icon={<Shield size={30} strokeWidth={1.5} />} text={t('system.fw.unavailable')} />
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex flex-wrap items-center gap-2 px-3 h-10 border-b border-bd shrink-0">
              <span className="text-[11px] text-faint shrink-0">{fw}</span>
              <div className="w-24">
                <Input
                  value={fwPort}
                  onChange={e => setFwPort(e.target.value.replace(/[^\d]/g, ''))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void allowPort()
                  }}
                  placeholder={t('system.fw.portPh')}
                  type="number"
                  min={1}
                  max={65535}
                />
              </div>
              <div className="w-24">
                <Select
                  value={fwProto}
                  onChange={v => setFwProto(v as 'tcp' | 'udp')}
                  options={[
                    { value: 'tcp', label: 'TCP' },
                    { value: 'udp', label: 'UDP' },
                  ]}
                />
              </div>
              <Button size="sm" variant="primary" disabled={!fwPort} onClick={() => void allowPort()}>
                {t('system.fw.allow')}
              </Button>
              <span className="text-[11px] text-faint">{t('system.fw.allowHint')}</span>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {fw === 'ufw' && ufwRules.length > 0 ? (
                <table className="w-full text-[12px] border-collapse max-w-3xl">
                  <thead>
                    <tr className="text-dim border-b border-bd">
                      <th className="font-normal px-2 h-8 text-left w-16">#</th>
                      <th className="font-normal px-2 h-8 text-left">{t('system.fw.rules')}</th>
                      <th className="font-normal px-2 h-8 text-right w-20">{t('system.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ufwRules.map(r => (
                      <tr key={r.num} className="border-b border-bd/40 hover:bg-hover">
                        <td className="px-2 h-8 text-dim tabular-nums">{r.num}</td>
                        <td className="px-2 h-8 font-mono text-fg">{r.raw}</td>
                        <td className="px-2 h-8 text-right">
                          <SvcBtn label={t('system.fw.delete')} onClick={() => void deleteUfwRule(r)}>
                            <Trash2 size={12} />
                          </SvcBtn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <pre className="text-[12px] leading-relaxed font-mono text-dim whitespace-pre-wrap selectable break-all">
                  {fwText || t('common.empty')}
                </pre>
              )}
              {fw !== 'ufw' && (
                <div className="text-[11px] text-faint mt-3">{t('system.fw.rawHint')}</div>
              )}
            </div>
          </div>
        )}

        {opLabel && (
          <div className="absolute inset-0 bg-bg/50 flex flex-col items-center justify-center gap-2 z-20">
            <Spinner size={20} />
            <div className="text-xs text-dim">{opLabel}</div>
          </div>
        )}
      </div>

      {logReq && sessionId && (
        <StreamLogModal
          sessionId={sessionId}
          title={logReq.title}
          command={logReq.command}
          onClose={() => {
            const reload = logReq.reload
            setLogReq(null)
            if (reload) void load()
          }}
        />
      )}
    </>
  )

  return <div className="flex flex-col h-full bg-bg">{body}</div>
}

/** 服务/软件包行内小按钮 */
function SvcBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        onClick={onClick}
        disabled={disabled}
        className="size-6 flex items-center justify-center rounded text-dim hover:text-fg hover:bg-hover transition-colors disabled:opacity-25"
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** 流式命令输出弹窗（服务日志 / 安装卸载） */
function StreamLogModal({
  sessionId,
  title,
  command,
  onClose,
}: {
  sessionId: string
  title: string
  command: string
  onClose: () => void
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [code, setCode] = useState<number | null>(null)
  const streamRef = useRef<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const offData = window.api.onSshStreamData((id, data) => {
      if (id !== streamRef.current) return
      setText(prev => prev + data)
    })
    const offClose = window.api.onSshStreamClose((id, c) => {
      if (id !== streamRef.current) return
      setCode(c)
    })
    void window.api.sshExecStream(sessionId, command).then(id => {
      streamRef.current = id
    })
    return () => {
      offData()
      offClose()
      if (streamRef.current) window.api.sshStreamKill(streamRef.current)
    }
  }, [sessionId, command])

  // 输出增长时自动滚到底部
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      title={title}
      footer={
        <>
          {code !== null && (
            <span className={`text-xs mr-auto ${code === 0 ? 'text-accent' : 'text-danger'}`}>
              {code === 0 ? t('system.logDone') : `${t('system.logFailed')} (exit ${code})`}
            </span>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      <pre
        ref={preRef}
        className="h-[50vh] overflow-auto rounded-md bg-black/40 border border-bd p-3 text-[12px] leading-relaxed font-mono text-term-fg whitespace-pre-wrap break-all selectable"
      >
        {text || t('system.logWaiting')}
      </pre>
    </Modal>
  )
}
