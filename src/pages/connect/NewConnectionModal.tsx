import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Save } from 'lucide-react'
import type { AuthType, Connection } from '../../../electron/shared/types'
import { useConnStore } from '../../stores/connStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n/I18nProvider'
import {
  Button,
  Input,
  Modal,
  PasswordInput,
  Segmented,
  Select,
  message,
} from '../../components/ui'

const DEFAULT_CONN: Omit<Connection, 'id' | 'createdAt'> = {
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  keyPassphrase: '',
  groupId: null,
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="text-[13px] text-dim mb-1.5">{label}</div>
      {children}
    </div>
  )
}

/** 新建/编辑连接弹窗（参照设计图） */
export function NewConnectionModal() {
  const t = useT()
  const open = useUiStore(s => s.newConnOpen)
  const editing = useUiStore(s => s.editingConn)
  const close = useUiStore(s => s.closeConnModal)
  const groups = useConnStore(s => s.groups)
  const saveConnection = useConnStore(s => s.saveConnection)
  const openTerminal = useSessionStore(s => s.openTerminal)

  const [form, setForm] = useState(DEFAULT_CONN)

  useEffect(() => {
    if (!open) return
    if (editing) {
      const { id: _id, createdAt: _createdAt, ...rest } = editing
      setForm({ ...DEFAULT_CONN, ...rest })
    } else {
      setForm({ ...DEFAULT_CONN })
    }
  }, [open, editing])

  const patch = (p: Partial<typeof form>) => setForm(f => ({ ...f, ...p }))

  async function handleConnect() {
    if (!form.host.trim()) {
      message.warning(t('msg.hostRequired'))
      return
    }
    const name = form.name.trim() || `${form.username}@${form.host}`
    const conn: Connection = {
      ...form,
      name,
      host: form.host.trim(),
      id: editing?.id ?? crypto.randomUUID(),
      createdAt: editing?.createdAt ?? Date.now(),
    }
    try {
      await saveConnection(conn)
      close()
      // 编辑仅保存；新建后直接发起连接
      if (editing) message.success(t('msg.saved'))
      else await openTerminal(conn.id)
    } catch (e) {
      message.error(t('msg.opFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? t('newConn.titleEdit') : t('newConn.title')}
      width={440}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            icon={editing ? <Save size={14} /> : <ArrowRight size={14} />}
            onClick={handleConnect}
          >
            {editing ? t('common.save') : t('common.connect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 pt-1">
        <Field label={t('newConn.name')}>
          <Input
            value={form.name}
            onChange={e => patch({ name: e.target.value })}
            placeholder={t('newConn.namePh')}
            autoFocus
          />
        </Field>

        <Field label={t('newConn.host')}>
          <Input
            value={form.host}
            onChange={e => patch({ host: e.target.value })}
            placeholder={t('newConn.hostPh')}
          />
        </Field>

        <div className="flex gap-3">
          <Field label={t('newConn.port')} className="w-24 shrink-0">
            <Input
              type="number"
              value={form.port}
              onChange={e => patch({ port: Number(e.target.value) || 22 })}
            />
          </Field>
          <Field label={t('newConn.username')} className="flex-1">
            <Input value={form.username} onChange={e => patch({ username: e.target.value })} />
          </Field>
        </div>

        <Field label={t('newConn.authType')}>
          <Segmented<AuthType>
            value={form.authType}
            onChange={v => patch({ authType: v })}
            options={[
              { label: t('newConn.password'), value: 'password' },
              { label: t('newConn.privateKey'), value: 'key' },
            ]}
          />
        </Field>

        {form.authType === 'password' ? (
          <Field label={t('newConn.password')}>
            <PasswordInput
              value={form.password ?? ''}
              onChange={e => patch({ password: e.target.value })}
            />
          </Field>
        ) : (
          <>
            <Field label={t('newConn.keyPath')}>
              <div className="flex gap-2">
                <Input
                  value={form.privateKeyPath ?? ''}
                  onChange={e => patch({ privateKeyPath: e.target.value })}
                  placeholder="~/.ssh/id_rsa"
                />
                <Button
                  onClick={async () => {
                    const p = await window.api.pickPrivateKey()
                    if (p) patch({ privateKeyPath: p })
                  }}
                >
                  {t('newConn.browse')}
                </Button>
              </div>
            </Field>
            <Field label={t('newConn.passphrase')}>
              <PasswordInput
                value={form.keyPassphrase ?? ''}
                onChange={e => patch({ keyPassphrase: e.target.value })}
              />
            </Field>
          </>
        )}

        {groups.length > 0 && (
          <Field label={t('newConn.group')}>
            <Select
              value={form.groupId ?? ''}
              onChange={v => patch({ groupId: v || null })}
              options={[
                { label: t('newConn.groupNone'), value: '' },
                ...groups.map(g => ({ label: g.name, value: g.id })),
              ]}
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}
