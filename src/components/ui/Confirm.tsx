import { useEffect, useReducer, useState } from 'react'
import { Button } from './Button'
import { Checkbox } from './Checkbox'
import { Modal } from './Modal'
import { useT } from '../../i18n/I18nProvider'

export interface ConfirmOptions {
  title: string
  content?: string
  okText?: string
  cancelText?: string
  /** 危险操作（红色确认按钮） */
  danger?: boolean
}

type PendingConfirm = ConfirmOptions & { resolve: (v: boolean) => void }

let pending: PendingConfirm | null = null
let alerting: (AlertOptions & { close: () => void }) | null = null
const subs = new Set<() => void>()

interface ConflictRequest {
  token: string
  target: 'remote' | 'local'
  name: string
  dir: string
  showCheckbox: boolean
}

let pendingConflict: ConflictRequest | null = null

function notify() {
  subs.forEach(f => f())
}

/** 命令式确认弹窗，返回 Promise<boolean> */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    pending = { ...opts, resolve }
    notify()
  })
}

export interface AlertOptions {
  title: string
  content?: string
  okText?: string
  /** 是否显示为危险（红色）样式 */
  danger?: boolean
}

/** 命令式提示弹窗（用于错误/重要信息展示） */
export function modalAlert(opts: AlertOptions): Promise<void> {
  return new Promise(resolve => {
    alerting = {
      ...opts,
      close: () => {
        alerting = null
        resolve()
      },
    }
    notify()
  })
}

/** 统一错误弹窗：标题 + 详细信息 */
export function errorAlert(title: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err ?? '未知错误')
  return modalAlert({ title, content: msg, danger: true })
}

/** 确认弹窗宿主组件，挂载于 App 根部 */
export function ConfirmHost() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  const [applyAll, setApplyAll] = useState(false)
  const t = useT()

  useEffect(() => {
    subs.add(force)
    return () => {
      subs.delete(force)
    }
  }, [])

  // 订阅主进程的 SFTP 同名冲突询问
  useEffect(() => {
    const off = window.api.onSftpConflict(req => {
      pendingConflict = req
      setApplyAll(false)
      force()
    })
    return off
  }, [])

  const closeConfirm = (v: boolean) => {
    pending?.resolve(v)
    pending = null
    force()
  }

  const closeAlert = () => {
    alerting?.close()
    force()
  }

  const replyConflict = (
    result: { action: 'overwrite' | 'rename' | 'skip'; applyAll: boolean } | 'cancel',
  ) => {
    if (pendingConflict) {
      void window.api.sftpConflictReply(pendingConflict.token, result)
      pendingConflict = null
      force()
    }
  }

  if (pendingConflict) {
    const c = pendingConflict
    const msg = c.target === 'remote'
      ? t('sftp.conflictRemote', { name: c.name })
      : t('sftp.conflictLocal', { name: c.name })
    return (
      <Modal
        open
        onClose={() => replyConflict('cancel')}
        title={t('sftp.conflictTitle')}
        width={420}
        closable={false}
        maskClosable={false}
        footer={
          <>
            <Button onClick={() => replyConflict('cancel')}>{t('sftp.cancel')}</Button>
            <Button onClick={() => replyConflict({ action: 'skip', applyAll })}>
              {t('sftp.conflictSkip')}
            </Button>
            <Button onClick={() => replyConflict({ action: 'rename', applyAll })}>
              {t('common.rename')}
            </Button>
            <Button variant="primary" onClick={() => replyConflict({ action: 'overwrite', applyAll })}>
              {t('sftp.overwrite')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-fg leading-relaxed select-text break-all">{msg}</div>
          <div className="text-xs text-dim font-mono break-all select-text">
            {t('sftp.conflictDir', { dir: c.dir })}
          </div>
          {c.showCheckbox && (
            <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none">
              <Checkbox checked={applyAll} onChange={setApplyAll} />
              {t('sftp.applyAll')}
            </label>
          )}
        </div>
      </Modal>
    )
  }

  if (pending) {
    const current = pending
    return (
      <Modal
        open
        onClose={() => closeConfirm(false)}
        title={current.title}
        width={400}
        maskClosable={false}
        footer={
          <>
            <Button onClick={() => closeConfirm(false)}>
              {current.cancelText ?? t('common.cancel')}
            </Button>
            <Button variant={current.danger ? 'danger' : 'primary'} onClick={() => closeConfirm(true)}>
              {current.okText ?? t('common.confirm')}
            </Button>
          </>
        }
      >
        {current.content && (
          <div className="text-[13px] text-dim leading-relaxed">{current.content}</div>
        )}
      </Modal>
    )
  }

  if (alerting) {
    const current = alerting
    return (
      <Modal
        open
        onClose={closeAlert}
        title={current.title}
        width={420}
        footer={
          <Button variant={current.danger ? 'danger' : 'primary'} onClick={closeAlert}>
            {current.okText ?? t('common.ok')}
          </Button>
        }
      >
        {current.content && (
          <div className="text-[13px] text-dim leading-relaxed selectable break-all">{current.content}</div>
        )}
      </Modal>
    )
  }

  return null
}
