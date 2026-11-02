import {
  Bot,
  CheckCircle2,
  Cloud,
  FolderOpen,
  Globe,
  GripVertical,
  Server,
  SlidersHorizontal,
  SquareTerminal,
  XCircle,
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useConnStore } from '../../stores/connStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import { Button, Input, PasswordInput, message, confirm, Modal, Segmented, Select, Switch, Tabs } from '../../components/ui'
import { useState } from 'react'
import {
  AI_PROVIDER_PRESETS,
  normalizeToolbarSettings,
  type AiErrorCode,
  type AiProviderId,
  type AllConfig,
  type SyncScope,
  type ToolbarItemId,
} from '../../../electron/shared/types'
import { TOOLBAR_META } from '../terminal/toolbarMeta'

type SettingsTab = 'general' | 'terminal' | 'toolbar' | 'ssh' | 'ai' | 'sync'
type SyncAction = 'export' | 'import' | 'test' | 'upload' | 'download'

/** 网络类错误转本地化排查提示；http/parse 等直接展示服务端原文 */
function localAiError(
  code: AiErrorCode | undefined,
  raw: string,
  t: ReturnType<typeof useT>,
): string {
  if (code === 'timeout') return t('settings.aiErrTimeout')
  if (code === 'proxy') return t('settings.aiErrProxy')
  if (code === 'dns') return t('settings.aiErrDns')
  if (code === 'network') return raw
  return raw
}

/** 字节数转为可读大小（上传成功提示用） */
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 设置弹窗：通用 / 终端 / SSH / AI / 配置同步 */
export function SettingsModal() {
  const t = useT()
  const open = useUiStore(s => s.settingsOpen)
  const setOpen = useUiStore(s => s.setSettingsOpen)
  const settings = useAppStore(s => s.settings)
  const dataDir = useAppStore(s => s.dataDir)
  const { setSettings, setLanguage, setTerminal, setToolbar, setSsh, setAi, setSync, setWebdav } =
    useAppStore.getState()

  const [tab, setTab] = useState<SettingsTab>('general')
  /** 工具栏拖拽中的行索引与目标行索引 */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  /** 同步操作进行状态（同一时间只允许一个） */
  const [syncBusy, setSyncBusy] = useState<SyncAction | null>(null)
  /** 同步范围：全部配置 / 仅连接列表（连接列表使用独立备份文件） */
  const [syncScope, setSyncScope] = useState<SyncScope>('all')
  /** WebDAV 连通性测试结果 */
  const [webdavTest, setWebdavTest] = useState<{ ok: boolean; message: string } | null>(null)
  /** AI 连通性测试状态 */
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{
    ok: boolean
    detail: string
    code?: AiErrorCode
  } | null>(null)

  /** 切换服务商预设：自动带入接口地址与示例模型（API Key 保留），同时清空旧测试结果 */
  function pickProvider(id: string) {
    const preset = AI_PROVIDER_PRESETS.find(p => p.id === id)
    if (!preset) return
    setAi({ provider: preset.id as AiProviderId, baseUrl: preset.baseUrl, model: preset.model })
    setAiTestResult(null)
  }

  /** 用当前表单配置（已实时保存）发起一次最小请求验证可用性 */
  async function runAiTest() {
    if (aiTesting) return
    setAiTesting(true)
    setAiTestResult(null)
    try {
      const r = await window.api.aiTest(settings.ai)
      if (r.ok) {
        setAiTestResult({ ok: true, detail: r.reply ?? '' })
        message.success(t('settings.aiTestOkOnly'))
      } else {
        const raw = r.error ?? 'Unknown error'
        setAiTestResult({
          ok: false,
          code: r.code,
          detail: localAiError(r.code, raw, t),
        })
      }
    } catch (e) {
      setAiTestResult({
        ok: false,
        code: 'network',
        detail: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setAiTesting(false)
    }
  }

  /** 将导入/下载得到的最新配置同步到渲染进程 store */
  function applySyncedConfig(cfg: AllConfig) {
    document.documentElement.dataset.theme = cfg.settings.theme
    useAppStore.getState().hydrate(cfg.settings, cfg.dataDir)
    useConnStore.getState().hydrate(cfg.connections, cfg.groups)
  }

  function requireSyncPassword() {
    if (!settings.sync.password.trim()) {
      message.error(t('settings.syncNoPassword'))
      return false
    }
    return true
  }

  function requireWebdav() {
    if (!settings.sync.webdav.url.trim() || !settings.sync.webdav.fileName.trim()) {
      message.error(t('settings.syncNeedWebdav'))
      return false
    }
    return true
  }

  async function runSync(action: SyncAction) {
    if (syncBusy) return

    if (action === 'test') {
      if (!requireWebdav()) return
      setSyncBusy('test')
      setWebdavTest(null)
      try {
        const r = await window.api.syncTestWebdav(settings.sync.webdav)
        setWebdavTest({ ok: r.ok, message: r.message })
      } catch (e) {
        setWebdavTest({ ok: false, message: e instanceof Error ? e.message : String(e) })
      } finally {
        setSyncBusy(null)
      }
      return
    }

    if (!requireSyncPassword()) return
    if ((action === 'upload' || action === 'download') && !requireWebdav()) return

    setSyncBusy(action)
    try {
      const password = settings.sync.password
      const webdav = settings.sync.webdav
      switch (action) {
        case 'export': {
          const r = await window.api.syncExportFile(password, syncScope)
          if (!r.canceled) {
            message.success(
              t('settings.syncExportDone', { count: r.connections, path: r.path ?? '' }),
            )
          }
          break
        }
        case 'import': {
          const cfg = await window.api.syncImportFile(password)
          if (!cfg) break
          applySyncedConfig(cfg)
          message.success(t('settings.syncImportDone', { count: cfg.connections.length }))
          break
        }
        case 'upload': {
          const ok = await confirm({ title: t('settings.syncUploadConfirm'), danger: true })
          if (!ok) break
          const r = await window.api.syncUploadWebdav(password, webdav, syncScope)
          message.success(
            t('settings.syncUploadDone', { count: r.connections, size: formatSize(r.bytes) }),
          )
          break
        }
        case 'download': {
          const cfg = await window.api.syncDownloadWebdav(password, webdav, syncScope)
          applySyncedConfig(cfg)
          message.success(t('settings.syncImportDone', { count: cfg.connections.length }))
          break
        }
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncBusy(null)
    }
  }

  const number = (v: string, fallback: number) => {
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? fallback : n
  }

  /** 工具栏配置（归一化后展示，避免旧配置缺项） */
  const toolbarItems = normalizeToolbarSettings(settings.toolbar).items

  /** 拖拽排序：移动后立即写回设置 */
  function moveToolbarItem(from: number, to: number) {
    if (from === to) return
    const next = [...toolbarItems]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setToolbar({ items: next })
  }

  function toggleToolbarItem(id: ToolbarItemId, enabled: boolean) {
    setToolbar({ items: toolbarItems.map(it => (it.id === id ? { ...it, enabled } : it)) })
  }

  const Row = ({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{label}</div>
        {desc && <div className="text-xs text-faint mt-0.5">{desc}</div>}
      </div>
      <div className="w-44 shrink-0 flex justify-end">{children}</div>
    </div>
  )

  return (
    <Modal open={open} onClose={() => setOpen(false)} title={t('settings.title')} width={580}>
      <div className="flex gap-5 min-h-[380px]">
        <div className="w-36 shrink-0 border-r border-bd pr-3">
          <Tabs
            vertical
            active={tab}
            onChange={setTab}
            items={[
              { key: 'general', label: t('settings.general'), icon: <Globe size={15} /> },
              { key: 'terminal', label: t('settings.terminal'), icon: <SquareTerminal size={15} /> },
              { key: 'toolbar', label: t('settings.toolbar'), icon: <SlidersHorizontal size={15} /> },
              { key: 'ssh', label: t('settings.ssh'), icon: <Server size={15} /> },
              { key: 'ai', label: t('settings.ai'), icon: <Bot size={15} /> },
              { key: 'sync', label: t('settings.sync'), icon: <Cloud size={15} /> },
            ]}
          />
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto max-h-[60vh]">
          {tab === 'general' && (
            <div className="divide-y divide-bd/60">
              <Row label={t('settings.language')} desc={t('settings.languageDesc')}>
                <Select
                  value={settings.language}
                  onChange={v => setLanguage(v as typeof settings.language)}
                  options={[
                    { label: '简体中文', value: 'zh-CN' },
                    { label: 'English', value: 'en-US' },
                  ]}
                />
              </Row>
              <Row label={t('settings.restoreSession')} desc={t('settings.restoreSessionDesc')}>
                <Switch checked={settings.restoreSession} onChange={v => setSettings({ restoreSession: v })} />
              </Row>
              <Row label={t('settings.autoUpdate')} desc={t('settings.autoUpdateDesc')}>
                <Switch checked={settings.autoUpdate} onChange={v => setSettings({ autoUpdate: v })} />
              </Row>
              <Row label={t('settings.dataDir')} desc={t('settings.dataDirDesc')}>
                <Button icon={<FolderOpen size={14} />} onClick={() => void window.api.openPath(dataDir)}>
                  {t('settings.openDataDir')}
                </Button>
              </Row>
            </div>
          )}

          {tab === 'terminal' && (
            <div className="divide-y divide-bd/60">
              <Row label={t('settings.fontFamily')}>
                <Input
                  value={settings.terminal.fontFamily}
                  onChange={e => setTerminal({ fontFamily: e.target.value })}
                />
              </Row>
              <Row label={t('settings.fontSize')}>
                <Input
                  type="number"
                  min={8}
                  max={32}
                  value={settings.terminal.fontSize}
                  onChange={e => setTerminal({ fontSize: number(e.target.value, 14) })}
                />
              </Row>
              <Row label={t('settings.cursorStyle')}>
                <Select
                  value={settings.terminal.cursorStyle}
                  onChange={v => setTerminal({ cursorStyle: v as typeof settings.terminal.cursorStyle })}
                  options={[
                    { label: t('settings.cursorBlock'), value: 'block' },
                    { label: t('settings.cursorUnderline'), value: 'underline' },
                    { label: t('settings.cursorBar'), value: 'bar' },
                  ]}
                />
              </Row>
              <Row label={t('settings.cursorBlink')}>
                <Switch checked={settings.terminal.cursorBlink} onChange={v => setTerminal({ cursorBlink: v })} />
              </Row>
              <Row label={t('settings.scrollback')}>
                <Input
                  type="number"
                  min={100}
                  max={100000}
                  step={100}
                  value={settings.terminal.scrollback}
                  onChange={e => setTerminal({ scrollback: number(e.target.value, 5000) })}
                />
              </Row>
              <Row label={t('settings.editorMaxSize')} desc={t('settings.editorMaxSizeDesc')}>
                <Input
                  type="number"
                  min={1}
                  max={1024}
                  step={1}
                  value={settings.terminal.editorMaxSizeMB}
                  onChange={e => setTerminal({ editorMaxSizeMB: number(e.target.value, 2) })}
                />
              </Row>
              <Row label={t('settings.bell')}>
                <Switch
                  checked={settings.terminal.bellStyle === 'sound'}
                  onChange={v => setTerminal({ bellStyle: v ? 'sound' : 'none' })}
                />
              </Row>
            </div>
          )}

          {tab === 'toolbar' && (
            <div>
              <p className="text-xs text-faint leading-relaxed pb-3">{t('settings.toolbarDesc')}</p>
              <div className="divide-y divide-bd/60">
                {toolbarItems.map((it, i) => {
                  const meta = TOOLBAR_META[it.id]
                  return (
                    <div
                      key={it.id}
                      draggable
                      onDragStart={e => {
                        setDragIndex(i)
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', it.id)
                      }}
                      onDragOver={e => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        setOverIndex(i)
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        if (dragIndex !== null) moveToolbarItem(dragIndex, i)
                        setDragIndex(null)
                        setOverIndex(null)
                      }}
                      onDragEnd={() => {
                        setDragIndex(null)
                        setOverIndex(null)
                      }}
                      className={`flex items-center gap-2.5 py-2.5 px-2 -mx-2 rounded-md cursor-grab transition-colors ${
                        dragIndex === i ? 'opacity-40' : 'hover:bg-hover'
                      } ${overIndex === i && dragIndex !== i ? 'bg-accent-dim' : ''}`}
                    >
                      <GripVertical size={14} className="text-faint shrink-0" />
                      <meta.icon size={15} className="text-dim shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-fg">{t(meta.labelKey)}</div>
                        <div className="text-xs text-faint mt-0.5">{t(meta.descKey)}</div>
                      </div>
                      <Switch checked={it.enabled} onChange={v => toggleToolbarItem(it.id, v)} />
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 text-xs text-faint leading-relaxed">
                {t('settings.toolbar.telnetHint')}
              </div>
              <div className="mt-1 text-xs text-faint leading-relaxed">
                {t('settings.toolbar.disconnectHint')}
              </div>
            </div>
          )}

          {tab === 'ssh' && (
            <div className="divide-y divide-bd/60">
              <Row label={t('settings.keepalive')} desc={t('settings.keepaliveDesc')}>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={settings.ssh.keepaliveInterval}
                  onChange={e => setSsh({ keepaliveInterval: number(e.target.value, 30) })}
                />
              </Row>
              <Row label={t('settings.timeout')}>
                <Input
                  type="number"
                  min={3}
                  max={120}
                  value={settings.ssh.connectTimeout}
                  onChange={e => setSsh({ connectTimeout: number(e.target.value, 15) })}
                />
              </Row>
              <Row label={t('settings.compression')} desc={t('settings.compressionDesc')}>
                <Switch checked={settings.ssh.compression} onChange={v => setSsh({ compression: v })} />
              </Row>
              <Row label={t('settings.autoReconnect')} desc={t('settings.autoReconnectDesc')}>
                <Switch checked={settings.ssh.autoReconnect} onChange={v => setSsh({ autoReconnect: v })} />
              </Row>
              <Row label={t('settings.transferConcurrency')} desc={t('settings.transferConcurrencyDesc')}>
                <Input
                  type="number"
                  min={1}
                  max={64}
                  value={settings.ssh.transferConcurrency}
                  onChange={e => setSsh({ transferConcurrency: number(e.target.value, 4) })}
                />
              </Row>
              <Row label={t('settings.transferSpeedLimit')} desc={t('settings.transferSpeedLimitDesc')}>
                <Input
                  type="number"
                  min={0}
                  value={settings.ssh.transferSpeedLimitKBps}
                  onChange={e => setSsh({ transferSpeedLimitKBps: Math.max(0, number(e.target.value, 0)) })}
                />
              </Row>
              <Row label={t('settings.x11Display')} desc={t('settings.x11DisplayDesc')}>
                <Input
                  value={settings.ssh.x11Display}
                  onChange={e => setSsh({ x11Display: e.target.value.trim() })}
                  placeholder="127.0.0.1:0"
                  spellCheck={false}
                />
              </Row>
            </div>
          )}

          {tab === 'sync' && (
            <div className="divide-y divide-bd/60">
              <AiField label={t('settings.syncScope')} desc={t('settings.syncScopeDesc')}>
                <Segmented
                  value={syncScope}
                  onChange={setSyncScope}
                  options={[
                    { label: t('settings.syncScopeAll'), value: 'all' },
                    { label: t('settings.syncScopeConn'), value: 'connections' },
                  ]}
                />
                {syncScope === 'connections' && (
                  <div className="mt-1.5 text-xs text-faint leading-relaxed">
                    {t('settings.syncConnFileHint')}
                  </div>
                )}
              </AiField>

              <AiField label={t('settings.syncPassword')} desc={t('settings.syncPasswordDesc')}>
                <PasswordInput
                  value={settings.sync.password}
                  onChange={e => setSync({ password: e.target.value })}
                  placeholder={t('settings.syncPasswordPh')}
                  autoComplete="off"
                />
              </AiField>

              <AiField label={t('settings.syncLocal')} desc={t('settings.syncMergeDesc')}>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    loading={syncBusy === 'export'}
                    disabled={!!syncBusy}
                    onClick={() => void runSync('export')}
                  >
                    {t('settings.syncExport')}
                  </Button>
                  <Button
                    variant="secondary"
                    loading={syncBusy === 'import'}
                    disabled={!!syncBusy}
                    onClick={() => void runSync('import')}
                  >
                    {t('settings.syncImport')}
                  </Button>
                </div>
              </AiField>

              <div className="py-3">
                <div className="text-[13px] text-fg">{t('settings.syncWebdav')}</div>
              </div>

              <AiField label={t('settings.syncWebdavUrl')} desc={t('settings.syncWebdavUrlDesc')}>
                <Input
                  value={settings.sync.webdav.url}
                  onChange={e => {
                    setWebdav({ url: e.target.value.trim() })
                    setWebdavTest(null)
                  }}
                  placeholder="https://dav.jianguoyun.com/dav/"
                  spellCheck={false}
                />
              </AiField>
              <AiField label={t('settings.syncWebdavUser')}>
                <Input
                  value={settings.sync.webdav.username}
                  onChange={e => setWebdav({ username: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </AiField>
              <AiField label={t('settings.syncWebdavPass')}>
                <PasswordInput
                  value={settings.sync.webdav.password}
                  onChange={e => setWebdav({ password: e.target.value })}
                  autoComplete="off"
                />
              </AiField>
              <AiField label={t('settings.syncWebdavDir')} desc={t('settings.syncWebdavDirDesc')}>
                <Input
                  value={settings.sync.webdav.remoteDir}
                  onChange={e => setWebdav({ remoteDir: e.target.value.trim() })}
                  spellCheck={false}
                />
              </AiField>
              <AiField label={t('settings.syncWebdavFile')}>
                <Input
                  value={settings.sync.webdav.fileName}
                  onChange={e => {
                    setWebdav({ fileName: e.target.value.trim() })
                    setWebdavTest(null)
                  }}
                  spellCheck={false}
                />
              </AiField>

              <div className="py-3">
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    loading={syncBusy === 'test'}
                    disabled={!!syncBusy}
                    onClick={() => void runSync('test')}
                  >
                    {t('settings.syncTest')}
                  </Button>
                  <Button
                    variant="secondary"
                    loading={syncBusy === 'upload'}
                    disabled={!!syncBusy}
                    onClick={() => void runSync('upload')}
                  >
                    {t('settings.syncUpload')}
                  </Button>
                  <Button
                    variant="secondary"
                    loading={syncBusy === 'download'}
                    disabled={!!syncBusy}
                    onClick={() => void runSync('download')}
                  >
                    {t('settings.syncDownload')}
                  </Button>
                </div>
                {webdavTest && (
                  <div
                    className={`mt-2 flex items-start gap-1.5 text-xs leading-5 ${
                      webdavTest.ok ? 'text-accent' : 'text-danger'
                    }`}
                  >
                    {webdavTest.ok ? (
                      <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                    ) : (
                      <XCircle size={14} className="mt-0.5 shrink-0" />
                    )}
                    <span className="break-all selectable">
                      {webdavTest.ok
                        ? webdavTest.message
                        : t('settings.syncTestFail') + webdavTest.message}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'ai' && (
            <div className="divide-y divide-bd/60">
              <AiField label={t('settings.aiMode')} desc={t('settings.aiModeDesc')}>
                <Segmented
                  value={settings.ai.mode}
                  onChange={v => setAi({ mode: v })}
                  options={[
                    { label: t('ai.modeChat'), value: 'chat' },
                    { label: t('ai.modeAgent'), value: 'agent' },
                  ]}
                />
              </AiField>
              <AiField label={t('settings.aiProvider')} desc={t('settings.aiProviderDesc')}>
                <Select
                  value={settings.ai.provider}
                  onChange={pickProvider}
                  options={AI_PROVIDER_PRESETS.map(p => ({
                    value: p.id,
                    label: p.id === 'custom' ? t('ai.providerCustom') : PROVIDER_LABELS[p.id],
                  }))}
                />
              </AiField>
              <AiField label={t('settings.aiApiKey')} desc={t('settings.aiApiKeyDesc')}>
                <PasswordInput
                  value={settings.ai.apiKey}
                  onChange={e => {
                    setAi({ apiKey: e.target.value })
                    setAiTestResult(null)
                  }}
                  placeholder={t('settings.aiKeyPh')}
                  autoComplete="off"
                />
              </AiField>
              <AiField label={t('settings.aiBaseUrl')}>
                <Input
                  value={settings.ai.baseUrl}
                  onChange={e => {
                    setAi({ baseUrl: e.target.value.trim() })
                    setAiTestResult(null)
                  }}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </AiField>
              <AiField label={t('settings.aiModel')} desc={t('settings.aiModelDesc')}>
                <Input
                  value={settings.ai.model}
                  onChange={e => {
                    setAi({ model: e.target.value.trim() })
                    setAiTestResult(null)
                  }}
                  placeholder="deepseek-chat / gpt-4o-mini / ep-xxxx"
                  spellCheck={false}
                />
              </AiField>
              <AiField label={t('settings.aiSystemPrompt')} desc={t('settings.aiSystemPromptDesc')}>
                <textarea
                  value={settings.ai.systemPrompt}
                  onChange={e => setAi({ systemPrompt: e.target.value })}
                  rows={4}
                  className="w-full bg-input border border-bd rounded-md px-3 py-2 text-[13px] leading-relaxed text-fg placeholder:text-faint transition-colors focus:border-accent hover:border-bd-strong outline-none resize-y"
                />
              </AiField>
            </div>
          )}

          {/* AI 连通性测试 */}
          {tab === 'ai' && (
            <div className="mt-3 flex items-start gap-3">
              <Button
                variant="secondary"
                loading={aiTesting}
                disabled={
                  !settings.ai.apiKey.trim() ||
                  !settings.ai.baseUrl.trim() ||
                  !settings.ai.model.trim()
                }
                onClick={() => void runAiTest()}
              >
                {t('settings.aiTest')}
              </Button>
              {aiTestResult && (
                <div
                  className={`min-w-0 flex items-start gap-1.5 text-xs leading-5 ${
                    aiTestResult.ok ? 'text-accent' : 'text-danger'
                  }`}
                >
                  {aiTestResult.ok ? (
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={14} className="mt-0.5 shrink-0" />
                  )}
                  <span className="break-all selectable">
                    {aiTestResult.ok ? (
                      aiTestResult.detail ? (
                        <>
                          {t('settings.aiTestOk')}
                          <span className="text-dim">
                            {settings.language === 'zh-CN'
                              ? `「${aiTestResult.detail}」`
                              : aiTestResult.detail}
                          </span>
                        </>
                      ) : (
                        t('settings.aiTestOkOnly')
                      )
                    ) : aiTestResult.code === 'timeout' ||
                      aiTestResult.code === 'proxy' ||
                      aiTestResult.code === 'dns' ? (
                      // 网络类错误的 detail 已是完整的本地化排查提示，不再加“连接失败”前缀
                      aiTestResult.detail
                    ) : (
                      <>{t('settings.aiTestFail')}{aiTestResult.detail}</>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end mt-3">
        <Button
          variant="primary"
          onClick={() => {
            setOpen(false)
            message.success(t('msg.saved'))
          }}
        >
          {t('common.ok')}
        </Button>
      </div>
    </Modal>
  )
}

/** 服务商品牌名（通用名称不随界面语言变化） */
const PROVIDER_LABELS: Record<AiProviderId, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  moonshot: 'Kimi (Moonshot)',
  dashscope: 'Qwen 通义千问',
  bigmodel: '智谱 GLM',
  volcengine: '豆包（火山方舟）',
  siliconflow: '硅基流动 SiliconFlow',
  custom: 'Custom',
}

/** AI 设置字段：label/desc 在上、控件占满整行 */
function AiField({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="py-3">
      <div className="text-[13px] text-fg">{label}</div>
      {desc && <div className="text-xs text-faint mt-1 leading-relaxed">{desc}</div>}
      <div className="mt-2">{children}</div>
    </div>
  )
}
