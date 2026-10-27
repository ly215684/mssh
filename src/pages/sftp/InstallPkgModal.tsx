import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Terminal, XCircle } from 'lucide-react'
import { Button, Modal } from '../../components/ui'
import { useT } from '../../i18n/I18nProvider'

/** 安装日志保留上限，超出后丢弃前半部分 */
const MAX_LOG_CHARS = 1_000_000

/**
 * 远程依赖包安装弹窗：流式展示包管理器的 stdout/stderr，
 * 结束后二次校验命令是否可用，并回调 onDone(success)。
 */
export function InstallPkgModal({
  sessionId,
  pkg,
  onClose,
  onDone,
}: {
  sessionId: string
  pkg: 'unzip' | 'tar'
  onClose: () => void
  onDone: (success: boolean) => void
}) {
  const t = useT()
  const [output, setOutput] = useState('')
  const [code, setCode] = useState<number | null>(null)
  /** 命令成功后做二次校验：'pending' | 'ok' | 'fail' */
  const [verify, setVerify] = useState<'pending' | 'ok' | 'fail'>('pending')
  const [error, setError] = useState<string | null>(null)
  const streamIdRef = useRef<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const isUnzip = pkg === 'unzip'

  // 启动流式安装
  useEffect(() => {
    let cancelled = false
    setOutput('')
    setCode(null)
    setVerify('pending')
    setError(null)
    const start = isUnzip
      ? window.api.sftpInstallUnzipStream(sessionId)
      : window.api.sftpInstallTarStream(sessionId)
    start
      .then(sid => {
        if (cancelled) {
          window.api.sshStreamKill(sid)
          return
        }
        streamIdRef.current = sid
      })
      .catch(e => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setCode(1)
          setVerify('fail')
        }
      })
    return () => {
      cancelled = true
      if (streamIdRef.current) {
        window.api.sshStreamKill(streamIdRef.current)
        streamIdRef.current = null
      }
    }
  }, [sessionId, isUnzip])

  // 订阅流式输出
  useEffect(() => {
    const offData = window.api.onSshStreamData((id, chunk) => {
      if (id !== streamIdRef.current) return
      setOutput(p => {
        const next = p + chunk
        return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS / 2) : next
      })
    })
    const offClose = window.api.onSshStreamClose(async (id, c) => {
      if (id !== streamIdRef.current) return
      streamIdRef.current = null
      setCode(c)
      if (c !== 0) {
        setVerify('fail')
        return
      }
      // 命令成功后二次校验命令是否真的可用
      try {
        const ok = isUnzip
          ? await window.api.sftpHasUnzip(sessionId)
          : await window.api.sftpHasTar(sessionId)
        setVerify(ok ? 'ok' : 'fail')
      } catch {
        setVerify('fail')
      }
    })
    return () => {
      offData()
      offClose()
    }
  }, [sessionId, isUnzip])

  // 输出自动滚动到底部
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [output])

  // 校验结束 → 回调外层
  useEffect(() => {
    if (verify === 'pending') return
    // 等待一次渲染让用户看到结果，再回调外层
    const timer = setTimeout(() => onDone(verify === 'ok'), 50)
    return () => clearTimeout(timer)
  }, [verify, onDone])

  const finished = code !== null && verify !== 'pending'
  const success = verify === 'ok'

  const handleClose = () => {
    if (streamIdRef.current) {
      window.api.sshStreamKill(streamIdRef.current)
      streamIdRef.current = null
    }
    onClose()
  }

  const titleKey = isUnzip ? 'sftp.installUnzipTitle' : 'sftp.installTarTitle'
  const runningKey = isUnzip ? 'sftp.installingUnzip' : 'sftp.installingTar'
  const doneKey = isUnzip ? 'sftp.installUnzipDone' : 'sftp.installTarDone'
  const failedKey = isUnzip ? 'sftp.installUnzipFailed' : 'sftp.installTarFailed'

  return (
    <Modal
      open
      onClose={handleClose}
      maskClosable={false}
      closable={finished}
      width={680}
      title={
        <span className="inline-flex items-center gap-2">
          <Terminal size={15} className="text-accent" />
          {t(titleKey)}
        </span>
      }
      footer={
        <div className="flex items-center gap-2.5 w-full">
          {code === null ? (
            <span className="text-xs text-dim inline-flex items-center gap-1.5 mr-auto">
              <Loader2 size={13} className="animate-spin" />
              {t(runningKey)}
            </span>
          ) : success ? (
            <span className="text-xs text-accent inline-flex items-center gap-1.5 mr-auto">
              <CheckCircle2 size={14} />
              {t(doneKey)}
            </span>
          ) : (
            <span className="text-xs text-danger inline-flex items-center gap-1.5 mr-auto">
              <XCircle size={14} />
              {t(failedKey)}
            </span>
          )}
          <Button size="sm" onClick={handleClose} disabled={!finished}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <pre
        ref={preRef}
        className="bg-term-bg text-term-fg font-mono text-xs leading-relaxed rounded-md border border-bd p-3 h-[52vh] overflow-auto whitespace-pre-wrap break-all m-0 select-text"
      >
        {output || (code === null ? t('common.loading') : error ?? '')}
      </pre>
    </Modal>
  )
}
