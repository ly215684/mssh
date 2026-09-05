import { useEffect, useRef, useState } from 'react'
import { Save } from 'lucide-react'
import { Button, Modal, Spinner, confirm, errorAlert } from '../../components/ui'
import { useT } from '../../i18n/I18nProvider'
import { getGlobalT } from '../../i18n/I18nProvider'
import { message } from '../../components/ui/Message'
import { useAppStore } from '../../stores/appStore'
import { monaco, detectLanguage, getMonacoTheme, registerThemes } from '../../utils/monaco'

interface FileEditorProps {
  open: boolean
  sessionId: string | null
  path: string
  onClose: () => void
}

let themesRegistered = false

/**
 * 远程文本文件编辑器（基于 Monaco Editor）
 * - 通过 SFTP 读取/写入文本内容
 * - 2MB 上限，二进制文件直接拒绝（主进程校验）
 * - 支持语法高亮、行号、多光标、撤销重做
 * - 未保存关闭前二次确认
 */
export function FileEditor({ open, sessionId, path, onClose }: FileEditorProps) {
  const t = useT()
  const theme = useAppStore(s => s.settings.theme)

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [lineCount, setLineCount] = useState(0)
  const [byteSize, setByteSize] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const originalRef = useRef('')

  const dirty = content !== original
  const fileName = path.split('/').pop() ?? path

  // 注册自定义主题（仅一次）
  useEffect(() => {
    if (!themesRegistered) {
      registerThemes()
      themesRegistered = true
    }
  }, [])

  // 打开时加载文件内容
  useEffect(() => {
    if (!open || !sessionId || !path) return
    setLoading(true)
    setContent('')
    setOriginal('')
    originalRef.current = ''
    void window.api
      .sftpReadFile(sessionId, path)
      .then(text => {
        setContent(text)
        setOriginal(text)
        originalRef.current = text
        setLineCount(text.split('\n').length)
        setByteSize(new Blob([text]).size)
      })
      .catch(e => {
        void errorAlert(getGlobalT()('sftp.opFailed'), e)
        onClose()
      })
      .finally(() => setLoading(false))
  }, [open, sessionId, path, onClose])

  // 创建 / 销毁 Monaco 编辑器
  useEffect(() => {
    if (!open || !containerRef.current) return

    const language = detectLanguage(fileName)
    const model = monaco.editor.createModel(content, language)
    modelRef.current = model

    const editor = monaco.editor.create(containerRef.current, {
      model,
      theme: getMonacoTheme(theme),
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "var(--font-mono)",
      lineNumbers: 'on',
      renderLineHighlight: 'all',
      scrollBeyondLastLine: false,
      minimap: { enabled: true },
      wordWrap: 'on',
      tabSize: 4,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      overviewRulerLanes: 0,
    })
    editorRef.current = editor

    // 内容变化：同步 dirty / 行数 / 字节数
    const changeSub = editor.onDidChangeModelContent(() => {
      const value = model.getValue()
      setContent(value)
      setLineCount(model.getLineCount())
      setByteSize(new Blob([value]).size)
    })

    // Ctrl+S / Cmd+S 保存
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSave()
    })

    // 自动聚焦
    editor.focus()

    return () => {
      changeSub.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
      modelRef.current = null
    }
    // 仅在打开时创建一次，content 变化通过 setValue 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 文件内容加载完成后，写入 Monaco model
  useEffect(() => {
    const model = modelRef.current
    if (!model || loading) return
    // 避免覆盖用户正在编辑的内容：仅当 model 当前值与原始值一致或为空时同步
    const current = model.getValue()
    if (current === originalRef.current || current === '') {
      if (current !== content) {
        model.setValue(content)
        originalRef.current = content
      }
    }
  }, [content, loading])

  // 主题切换
  useEffect(() => {
    if (editorRef.current) {
      monaco.editor.setTheme(getMonacoTheme(theme))
    }
  }, [theme])

  const handleSave = async () => {
    if (!sessionId || saving) return
    const value = modelRef.current?.getValue() ?? content
    setSaving(true)
    try {
      await window.api.sftpWriteFile(sessionId, path, value)
      setContent(value)
      setOriginal(value)
      originalRef.current = value
      setByteSize(new Blob([value]).size)
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
        <div
          ref={containerRef}
          className="w-full h-[60vh] border border-bd rounded-md overflow-hidden"
        />
      </div>
    </Modal>
  )
}
