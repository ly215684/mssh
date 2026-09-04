import { useEffect } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { useT, getGlobalT } from '../i18n/I18nProvider'
import { useUpdateStore } from '../stores/updateStore'
import { Button, Modal, Progress, Spinner, message, errorAlert } from './ui'

function formatSpeed(bps: number): string {
  if (!bps) return ''
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`
}

/**
 * 自动更新对话框：
 * - silent（启动自动检查）：无新版本不打扰；失败仅轻提示
 * - 手动检查：全流程弹窗反馈
 */
export function UpdateDialog() {
  const t = useT()
  const phase = useUpdateStore(s => s.phase)
  const silent = useUpdateStore(s => s.silent)
  const percent = useUpdateStore(s => s.percent)
  const bytesPerSecond = useUpdateStore(s => s.bytesPerSecond)
  const version = useUpdateStore(s => s.version)
  const errorMsg = useUpdateStore(s => s.errorMsg)
  const download = useUpdateStore(s => s.download)
  const install = useUpdateStore(s => s.install)
  const dismiss = useUpdateStore(s => s.dismiss)

  // 「已是最新」反馈
  useEffect(() => {
    if (phase !== 'none') return
    if (!silent) message.success(t('update.latest'))
    const id = setTimeout(() => dismiss(), silent ? 1500 : 0)
    return () => clearTimeout(id)
  }, [phase, silent, t, dismiss])

  // 出错反馈
  useEffect(() => {
    if (phase !== 'error') return
    if (silent) {
      message.warning(t('update.failedSilent'))
    } else {
      void errorAlert(t('update.failed'), errorMsg ?? '')
    }
    dismiss()
  }, [phase, silent, errorMsg, t, dismiss])

  const open =
    (phase === 'checking' && !silent) ||
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'downloaded'

  const closeBtn = (
    <Button variant="ghost" onClick={dismiss}>
      {t('update.later')}
    </Button>
  )

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={t('update.title')}
      width={380}
      footer={
        phase === 'available' ? (
          <>
            {closeBtn}
            <Button onClick={download}>
              <span className="flex items-center gap-1.5">
                <Download size={14} />
                {t('update.download')}
              </span>
            </Button>
          </>
        ) : phase === 'downloaded' ? (
          <>
            {closeBtn}
            <Button onClick={install}>{t('update.restart')}</Button>
          </>
        ) : undefined
      }
    >
      {phase === 'checking' && (
        <div className="flex items-center gap-3 py-2">
          <Spinner size={18} />
          <span className="text-[13px] text-fg">{t('update.checking')}</span>
        </div>
      )}

      {phase === 'available' && (
        <div className="py-2 text-[13px] text-fg">
          {t('update.available', { version: `v${version ?? ''}` })}
          <div className="mt-1 text-xs text-dim">{t('update.availableHint')}</div>
        </div>
      )}

      {phase === 'downloading' && (
        <div className="py-2">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw size={14} className="text-accent animate-spin" />
            <span className="text-[13px] text-fg">{t('update.downloading')}</span>
            <div className="flex-1" />
            <span className="text-xs text-dim mono">{Math.round(percent)}%</span>
          </div>
          <Progress value={percent} />
          <div className="mt-1.5 text-right text-[11px] text-faint mono">
            {formatSpeed(bytesPerSecond)}
          </div>
        </div>
      )}

      {phase === 'downloaded' && (
        <div className="py-2 text-[13px] text-fg">
          {t('update.downloaded', { version: `v${version ?? ''}` })}
          <div className="mt-1 text-xs text-dim">{t('update.restartHint')}</div>
        </div>
      )}
    </Modal>
  )
}

/** 供 StatusBar 等处手动触发检查 */
export function useCheckUpdate() {
  const check = useUpdateStore(s => s.check)
  const active = useUpdateStore(s => s.active)
  return () => {
    if (!active) {
      message.info(getGlobalT()('update.unavailableInDev'))
      return
    }
    void check(false)
  }
}
