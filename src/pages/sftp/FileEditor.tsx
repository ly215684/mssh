import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import { Button, Modal, Spinner, Tooltip, confirm, errorAlert } from '../../components/ui'
import { useT } from '../../i18n/I18nProvider'
import { getGlobalT } from '../../i18n/I18nProvider'
import { message } from '../../components/ui/Message'
import { useAppStore } from '../../stores/appStore'
import { monaco, detectLanguage, getMonacoTheme, registerThemes } from '../../utils/monaco'
import { BINARY_EXTS, extOf, isArchive, parentPath } from '../../utils/files'
import type { FileInfo } from '../../../electron/shared/types'

interface FileEditorProps {
  open: boolean
  sessionId: string | null
  path: string
  onClose: () => void
}

/** 单个文件的编辑缓冲：独立 Monaco model，切换时保留内容与撤销栈 */
interface BufferEntry {
  model: monaco.editor.ITextModel
  /** 服务端原始内容，用于 dirty 判断 */
  original: string
}

/**
 * Makefile 类文件（Makefile、Makefile.am、GNUmakefile、*.mk 等）
 * 中 Tab 与行尾空白都有语义（recipe 行必须以 Tab 开头，变量值里的行尾空格会被保留），
 * 粘贴时不做 Tab→空格 转换、也不清理行尾空白
 */
function isMakefileLike(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'gnumakefile' || lower.startsWith('makefile') || lower.endsWith('.mk')
}

/**
 * 粘贴内容规范化（从 Windows 等外部来源复制进来的文本）：
 * 换行 CRLF/CR → LF、不换行空格/全角空格 → 半角空格、Tab 按制表位展开为空格、清理行尾空白
 * @param keepWhitespace Makefile 类文件传 true：Tab 与行尾空白原样保留（其余规则照常）
 */
function normalizePastedText(text: string, tabSize: number, keepWhitespace: boolean): string {
  const size = tabSize > 0 ? tabSize : 4
  const normalized = text
    .replace(/\r\n?/g, '\n') // CRLF / CR → LF
    .replace(/[\u00A0\u3000]/g, ' ') // 不换行空格 / 全角空格 → 半角空格
  return normalized
    .split('\n')
    .map(line => {
      if (keepWhitespace) return line
      // Tab 按制表位展开，保证多行粘贴后的缩进对齐
      let out = ''
      for (const ch of line) {
        out += ch === '\t' ? ' '.repeat(size - (out.length % size)) : ch
      }
      return out.replace(/[ \t]+$/, '')
    })
    .join('\n')
}

/**
 * 远程文本文件编辑器（基于 Monaco Editor）
 * - 通过 SFTP 读取/写入文本内容
 * - 大小上限可配置，二进制文件直接拒绝（主进程校验）
 * - 支持语法高亮、行号、多光标、撤销重做
 * - 粘贴（Ctrl+V / Cmd+V / 右键菜单粘贴）时自动规范化换行与空格，
 *   再交给 Monaco 插入；Makefile 类文件保留 Tab 与行尾空白
 * - 右侧列出同目录下所有可编辑文件，点击即可快速切换；
 *   各文件内容与未保存修改按 model 独立保留，切换不丢失
 * - 存在未保存修改关闭前二次确认
 */
export function FileEditor({ open, sessionId, path, onClose }: FileEditorProps) {
  const t = useT()
  const theme = useAppStore(s => s.settings.theme)
  const editorMaxSizeMB = useAppStore(s => s.settings.terminal.editorMaxSizeMB)
  // 主题注册标记（Monaco 为全局单例，每次挂载最多注册一次即可）
  const themesRegisteredRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activePath, setActivePath] = useState('')
  const [lineCount, setLineCount] = useState(0)
  const [byteSize, setByteSize] = useState(0)
  const [dirty, setDirty] = useState(false)
  /** 各文件 dirty 状态，用于右侧列表的未保存标记 */
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())
  /** 同目录可编辑文件列表 */
  const [siblings, setSiblings] = useState<FileInfo[]>([])
  const [listLoading, setListLoading] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  /** 编辑器初始自带的空 model，首个文件加载后销毁 */
  const tempModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const buffersRef = useRef<Map<string, BufferEntry>>(new Map())
  /** 进行中的加载（按路径去重，支持快速连点） */
  const inflightRef = useRef<Map<string, Promise<void>>>(new Map())
  /** 用户最后选择的目标路径，乱序返回时只有最新目标才真正切换 */
  const desiredRef = useRef('')
  const activePathRef = useRef('')
  const handleSaveRef = useRef<() => void>(() => {})

  const fileName = activePath.split('/').pop() ?? path

  // 注册自定义主题（仅一次）
  useEffect(() => {
    if (!themesRegisteredRef.current) {
      registerThemes()
      themesRegisteredRef.current = true
    }
  }, [])

  // 创建 / 销毁 Monaco 编辑器（打开期间只创建一次）
  useEffect(() => {
    if (!open || !containerRef.current) return

    // 两个 Map 在组件生命周期内不会被重新赋值（仅原地增删），
    // 拷贝到局部变量供 cleanup 使用（满足 react-hooks 对 ref.current 的告警）
    const buffers = buffersRef.current
    const inflight = inflightRef.current

    const editor = monaco.editor.create(containerRef.current, {
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
    // 未显式传入 model 时 Monaco 会自动创建一个空 model
    tempModelRef.current = editor.getModel()

    // 内容变化：同步 dirty / 行数 / 字节数（事件对当前附加的 model 生效）
    const changeSub = editor.onDidChangeModelContent(() => {
      const model = editor.getModel()
      if (!model) return
      const value = model.getValue()
      setLineCount(model.getLineCount())
      setByteSize(new Blob([value]).size)
      const ap = activePathRef.current
      const buf = buffersRef.current.get(ap)
      if (!buf) return
      const isDirty = value !== buf.original
      setDirty(isDirty)
      setDirtyPaths(prev => {
        if (prev.has(ap) === isDirty) return prev
        const next = new Set(prev)
        if (isDirty) next.add(ap)
        else next.delete(ap)
        return next
      })
    })

    // Ctrl+S / Cmd+S 保存
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSaveRef.current()
    })

    // 粘贴规范化：捕获阶段拦截原生 paste 事件（Ctrl+V / Cmd+V / 系统菜单粘贴），
    // 转换换行与空格后再交给 Monaco 的粘贴逻辑插入，光标与撤销行为保持不变
    const container = containerRef.current
    /** 已由命令处理过的粘贴（右键菜单粘贴等），用于避免紧随其后的原生粘贴重复插入 */
    let handledByCommand = false

    const insertNormalized = (raw: string) => {
      const model = editor.getModel()
      if (!model || !raw) return
      const fileName = activePathRef.current.split('/').pop() ?? ''
      editor.trigger('keyboard', 'paste', {
        text: normalizePastedText(raw, model.getOptions().tabSize, isMakefileLike(fileName)),
        pasteOnNewLine: false,
        multicursorText: null,
        mode: null,
      })
    }

    const onPaste = (e: ClipboardEvent) => {
      if (handledByCommand) {
        // 同一次操作已插入过，仅阻止浏览器/Monaco 再次插入
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const model = editor.getModel()
      // 仅拦截编辑区内的纯文本粘贴：查找/替换框等内部输入框不处理，
      // 非文本内容（图片、文件）也交回 Monaco 默认逻辑
      if (!model || !editor.hasTextFocus()) return
      const raw = e.clipboardData?.getData('text/plain') ?? ''
      if (!raw) return
      e.preventDefault()
      e.stopPropagation()
      insertNormalized(raw)
    }
    container.addEventListener('paste', onPaste, true)

    // Monaco 自带右键菜单/命令面板的「粘贴」走内部 clipboardService，不触发 DOM paste 事件，
    // 这里用同名 command 覆盖（Monaco 同 id 命令后注册者优先生效）：
    // 改为读取主进程剪贴板，规范化后再走 Monaco 的粘贴逻辑
    const pasteAction = editor.addAction({
      id: 'editor.action.clipboardPasteAction',
      label: 'Paste',
      run: () => {
        handledByCommand = true
        setTimeout(() => {
          handledByCommand = false
        }, 0)
        void window.api.clipboardReadText().then(text => insertNormalized(text ?? ''))
      },
    })

    // 自动聚焦
    editor.focus()

    return () => {
      container.removeEventListener('paste', onPaste, true)
      pasteAction.dispose()
      changeSub.dispose()
      buffers.forEach(b => b.model.dispose())
      buffers.clear()
      tempModelRef.current?.dispose()
      tempModelRef.current = null
      editor.dispose()
      editorRef.current = null
      activePathRef.current = ''
      desiredRef.current = ''
      inflight.clear()
      setSiblings([])
      setDirtyPaths(new Set())
      setLineCount(0)
      setByteSize(0)
      setDirty(false)
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 把编辑器附加到指定文件的 model，并同步底栏状态 */
  const attachTo = useCallback((target: string, buf: BufferEntry) => {
    const editor = editorRef.current
    if (!editor) return
    activePathRef.current = target
    setActivePath(target)
    // 首次附加前销毁 Monaco 自动创建的临时空 model
    if (tempModelRef.current) {
      tempModelRef.current.dispose()
      tempModelRef.current = null
    }
    editor.setModel(buf.model)
    setLineCount(buf.model.getLineCount())
    setByteSize(new Blob([buf.model.getValue()]).size)
    setDirty(buf.model.getValue() !== buf.original)
    editor.focus()
  }, [])

  /** 加载并打开远程文件；已加载过则直接切换 */
  const openFile = useCallback(
    (target: string, isInitial: boolean) => {
      if (!sessionId) return
      const existing = buffersRef.current.get(target)
      if (existing) {
        desiredRef.current = target
        attachTo(target, existing)
        return
      }
      desiredRef.current = target
      let job = inflightRef.current.get(target)
      if (!job) {
        job = (async () => {
          setLoading(true)
          try {
            const text = await window.api.sftpReadFile(sessionId, target)
            const model = monaco.editor.createModel(text, detectLanguage(target))
            buffersRef.current.set(target, { model, original: text })
            // 只有该文件仍是用户最后选择的目标时才切换，乱序返回不抢焦点
            if (desiredRef.current === target) attachTo(target, buffersRef.current.get(target)!)
          } catch (e) {
            void errorAlert(getGlobalT()('sftp.opFailed'), e)
            if (isInitial) onClose()
          } finally {
            setLoading(false)
          }
        })()
        inflightRef.current.set(target, job)
        void job.finally(() => inflightRef.current.delete(target))
      }
    },
    [sessionId, attachTo, onClose],
  )

  /** 读取同目录列表，筛出可用内置编辑器打开的文件 */
  const loadSiblings = useCallback(
    async (p: string) => {
      if (!sessionId) return
      const dir = parentPath(p) ?? '/'
      setListLoading(true)
      try {
        const list = await window.api.sftpList(sessionId, dir)
        const maxBytes = Math.max(1, Math.min(editorMaxSizeMB, 1024)) * 1024 * 1024
        const files = list.filter(
          f =>
            !f.isDir &&
            !isArchive(f.name) &&
            !BINARY_EXTS.has(extOf(f.name)) &&
            f.size <= maxBytes,
        )
        // 保证当前打开的文件一定出现在列表中
        if (!files.some(f => f.path === p)) {
          const cur = list.find(f => f.path === p)
          if (cur) files.push(cur)
        }
        files.sort((a, b) => a.name.localeCompare(b.name))
        setSiblings(files)
      } catch (e) {
        void errorAlert(getGlobalT()('sftp.loadFailed'), e)
      } finally {
        setListLoading(false)
      }
    },
    [sessionId, editorMaxSizeMB],
  )

  // 打开时：定位到入口文件并加载同目录列表
  useEffect(() => {
    if (!open || !sessionId || !path) return
    setActivePath(path)
    openFile(path, true)
    void loadSiblings(path)
  }, [open, sessionId, path, openFile, loadSiblings])

  // 主题切换
  useEffect(() => {
    if (editorRef.current) {
      monaco.editor.setTheme(getMonacoTheme(theme))
    }
  }, [theme])

  const handleSave = async () => {
    if (!sessionId || saving) return
    const target = activePathRef.current
    const buf = buffersRef.current.get(target)
    if (!buf) return
    const value = buf.model.getValue()
    setSaving(true)
    try {
      await window.api.sftpWriteFile(sessionId, target, value)
      buf.original = value
      setDirty(false)
      setByteSize(new Blob([value]).size)
      setDirtyPaths(prev => {
        if (!prev.has(target)) return prev
        const next = new Set(prev)
        next.delete(target)
        return next
      })
      message.success(t('editor.saved'))
    } catch (e) {
      void errorAlert(getGlobalT()('sftp.opFailed'), e)
    } finally {
      setSaving(false)
    }
  }
  handleSaveRef.current = handleSave

  const handleClose = async () => {
    const anyDirty = [...buffersRef.current.values()].some(
      b => b.model.getValue() !== b.original,
    )
    if (anyDirty) {
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
      width={1080}
      title={
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate" title={activePath}>{t('editor.title')}</span>
          <span className="text-xs text-dim font-normal truncate" title={activePath}>{fileName}</span>
        </div>
      }
      footer={
        <>
          <div className="mr-auto flex items-center gap-3 text-[11px] text-faint">
            {!loading && activePath && (
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
          <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={handleSave}>
            {t('editor.save')}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {/* 编辑区 */}
        <div className="relative flex-1 min-w-0">
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

        {/* 同目录可编辑文件列表：点击快速切换 */}
        <div className="w-52 shrink-0 flex flex-col border border-bd rounded-md overflow-hidden">
          <div className="flex items-center gap-1 h-8 px-2.5 border-b border-bd shrink-0">
            <span className="text-[11px] font-medium text-dim flex-1 truncate">
              {t('editor.filesInDir')}
            </span>
            <Tooltip label={t('editor.refreshFiles')}>
              <button
                type="button"
                onClick={() => void loadSiblings(activePath || path)}
                className="size-5 flex items-center justify-center rounded text-dim hover:text-fg hover:bg-hover transition-colors"
              >
                <RefreshCw size={12} className={listLoading ? 'animate-spin' : ''} />
              </button>
            </Tooltip>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {siblings.map(f => {
              const active = f.path === activePath
              return (
                <button
                  key={f.path}
                  type="button"
                  title={f.name}
                  onClick={() => openFile(f.path, false)}
                  className={`w-full h-7 flex items-center gap-1.5 px-2.5 text-left text-xs transition-colors ${
                    active
                      ? 'bg-accent-dim/70 text-accent'
                      : 'text-dim hover:text-fg hover:bg-hover'
                  }`}
                >
                  <span className="truncate flex-1">{f.name}</span>
                  {dirtyPaths.has(f.path) && <span className="text-accent text-[10px] shrink-0">●</span>}
                </button>
              )
            })}
            {listLoading && siblings.length === 0 && (
              <div className="flex items-center justify-center py-3">
                <Spinner size={12} />
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
