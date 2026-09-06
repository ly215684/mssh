import { FolderOpen, Globe, Server, SquareTerminal } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import { Button, Input, message, Modal, Segmented, Select, Switch, Tabs } from '../../components/ui'
import { useState } from 'react'

type SettingsTab = 'general' | 'terminal' | 'ssh'

/** 设置弹窗：通用 / 终端 / SSH */
export function SettingsModal() {
  const t = useT()
  const open = useUiStore(s => s.settingsOpen)
  const setOpen = useUiStore(s => s.setSettingsOpen)
  const settings = useAppStore(s => s.settings)
  const dataDir = useAppStore(s => s.dataDir)
  const { setSettings, setLanguage, setTerminal, setSsh } = useAppStore.getState()

  const [tab, setTab] = useState<SettingsTab>('general')

  const number = (v: string, fallback: number) => {
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? fallback : n
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
              { key: 'ssh', label: t('settings.ssh'), icon: <Server size={15} /> },
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
                <Segmented
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
              <Row label={t('settings.bell')}>
                <Segmented
                  value={settings.terminal.bellStyle}
                  onChange={v => setTerminal({ bellStyle: v as typeof settings.terminal.bellStyle })}
                  options={[
                    { label: t('settings.bellNone'), value: 'none' },
                    { label: t('settings.bellSound'), value: 'sound' },
                  ]}
                />
              </Row>
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
