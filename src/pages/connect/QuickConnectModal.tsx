import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Connection } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import { Button, Input, Modal, PasswordInput, message } from '../../components/ui'

/** 解析 user@host:port */
function parseTarget(raw: string): { host: string; port: number; username: string } | null {
  const m = raw.trim().match(/^(?:(.+?)@)?(\[[\w:.]+\]|[\w.\-]+)(?::(\d{1,5}))?$/)
  if (!m) return null
  return {
    username: m[1] || 'root',
    host: m[2],
    port: m[3] ? Number(m[3]) : 22,
  }
}

/** 快速连接弹窗：一次性连接，不保存到连接列表 */
export function QuickConnectModal() {
  const t = useT()
  const open = useUiStore(s => s.quickConnOpen)
  const setOpen = useUiStore(s => s.setQuickConnOpen)
  const registerMemory = useConnStore(s => s.registerMemory)
  const openTerminal = useSessionStore(s => s.openTerminal)

  const [target, setTarget] = useState('')
  const [password, setPassword] = useState('')

  async function handleConnect() {
    const parsed = parseTarget(target)
    if (!parsed) {
      message.warning(t('msg.invalidTarget'))
      return
    }
    const conn: Connection = {
      id: crypto.randomUUID(),
      name: `${parsed.username}@${parsed.host}`,
      createdAt: Date.now(),
      ...parsed,
      authType: 'password',
      password,
    }
    // 仅注册到内存，不持久化
    registerMemory(conn)
    setOpen(false)
    await openTerminal(conn.id)
    setTarget('')
    setPassword('')
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={t('quick.title')}
      width={420}
      footer={
        <>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<ArrowRight size={14} />} onClick={handleConnect}>
            {t('common.connect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 pt-1">
        <div>
          <div className="text-[13px] text-dim mb-1.5">{t('quick.target')}</div>
          <Input
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder={t('quick.targetPh')}
            autoFocus
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
          />
        </div>
        <div>
          <div className="text-[13px] text-dim mb-1.5">{t('quick.password')}</div>
          <PasswordInput
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
          />
        </div>
        <div className="text-xs text-faint">{t('quick.hint')}</div>
      </div>
    </Modal>
  )
}
