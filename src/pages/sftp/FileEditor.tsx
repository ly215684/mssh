import { useEffect, useRef, useState } from 'react'
import { Save } from 'lucide-react'
import { Button, Modal, Spinner, confirm, errorAlert } from '../../components/ui'
import { useT } from '../../i18n/I18nProvider'
import { getGlobalT } from '../../i18n/I18nProvider'
import { message } from '../../components/ui/Message'

interface FileEditorProps {
  open: boolean
  sessionId: string | null
  path: string
  onClose: () => void
}

/**
 * 远程文本文件编辑器
 * - 通过 SFTP 读取/写入文本内容
 * - 2MB 上限，二进制文件直接拒绝（主进程校验）
 * - 未保存关闭前二次确认
 */
export function FileEditor({ open, sessionId, path, onClose }: FileEditorProps) {
  const t = useT()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [lineCount, setLineCount] = useState(0)
  const [byteSize, setByteSize] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const dirty = content !== original
  const fileName = path.split('/').pop() ?? path

  // 打开时加载文件内容
  useEffect(() => {
    if (!open || !sessionId || !path) return
    setLoading(true)
    setContent('')
    setOriginal('')
    void window.api
      .sftpReadFile(sessionId, path)
      .then(text => {
        setContent(text)
        setOriginal(text)
        setLineCount(text.split('\n').length)
        setByteSize(new Blob([text]).size)
      })
      .catch(e => {
        void errorAlert(getGlobalT()('sftp.opFailed'), e)
        onClose()
      })
      .finally(() => setLoading(false))
  }, [open, sessionId, path, onClose])

  const handleSave = async () => {
    if (!sessionId || saving) return
    setSaving(true)
    try {
      await window.api.sftpWriteFile(sessionId, path, content)
      setOriginal(content)
      setByteSize(new Blob([content]).size)
      message.success(t('editor.saved'))
    } catch (e) {
      void errorAlert(getGlobalT()('sftp.opFailed'), e)
    } finally {
      setSaving(false)
    }
  }

  const handleClose = async () => {
    if (dirty) {
      const ok = await confirm({
        title: t('editor.title'),
        content: t('editor.dirtyConfirm'),
        okText: t('editor.close'),
        danger: true,
      })
      if (!ok) return
    }
    onClose()
  }

  // 加载完成后自动聚焦编辑器
  useEffect(() => {
    if (open && !loading) textareaRef.current?.focus()
  }, [open, loading])

  return (
    <Modal
      open={open}
      onClose={handleClose}
      width={820}
      title={
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate" title={path}>{t('editor.title')}</span>
          <span className="text-xs text-dim font-normal truncate" title={path}>{fileName}</span>
        </div>
      }
      footer={
        <>
          <div className="mr-auto flex items-center gap-3 text-[11px] text-faint">
            {!loading && (
              <>
                <span>{lineCount} {t('common.lines')}</span>
                <span>{(byteSize / 1024).toFixed(1)} KB</span>
                {dirty && <span className="text-accent">●</span>}
              </>
            )}
          </div>
          <Button variant="secondary" onClick={handleClose}>
            {t('editor.cancel')}
          </Button>
          <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty || loading} onClick={handleSave}>
            {t('editor.save')}
          </Button>
        </>
      }
    >
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-elevated/80 z-10 rounded">
            <Spinner size={20} />
            <span className="ml-2 text-xs text-dim">{t('editor.loading')}</span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={content}
          spellCheck={false}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            // Ctrl+S / Cmd+S 保存
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
              e.preventDefault()
              void handleSave()
            }
          }}
          className="w-full h-[60vh] bg-bg border border-bd rounded-md p-3 text-[13px] leading-relaxed text-fg font-mono resize-none outline-none focus:border-accent transition-colors"
          style={{ tabSize: 4 }}
        />
      </div>
    </Modal>
  )
}
