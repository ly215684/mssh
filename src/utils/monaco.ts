import * as monaco from 'monaco-editor'

// Monaco worker 由 vite-plugin-monaco-editor 自动配置，无需手动设置 MonacoEnvironment

/** 根据文件扩展名推断 Monaco 语言 ID */
export function detectLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonc: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    lua: 'lua',
    pl: 'perl',
    r: 'r',
    dart: 'dart',
    vue: 'html',
    svelte: 'html',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    env: 'ini',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  }
  if (ext === '') {
    const lower = fileName.toLowerCase()
    if (lower === 'dockerfile') return 'dockerfile'
    if (lower === 'makefile') return 'makefile'
  }
  return map[ext] ?? 'plaintext'
}

/** 注册与应用色板匹配的 Monaco 主题 */
export function registerThemes() {
  monaco.editor.defineTheme('mssh-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0b0f0c',
      'editor.foreground': '#d9e4da',
      'editor.lineHighlightBackground': '#151c15',
      'editorLineNumber.foreground': '#556456',
      'editorLineNumber.activeForeground': '#7f8f81',
      'editor.selectionBackground': 'rgba(34, 197, 94, 0.3)',
      'editor.inactiveSelectionBackground': 'rgba(34, 197, 94, 0.15)',
      'editorCursor.foreground': '#22c55e',
      'editorWhitespace.foreground': '#3a4a3a',
      'editorIndentGuide.background': '#243024',
      'editorIndentGuide.activeBackground': '#3a4a3a',
      'editorWidget.background': '#151c15',
      'editorWidget.border': '#243024',
      'editorSuggestWidget.background': '#151c15',
      'editorSuggestWidget.border': '#243024',
      'editorSuggestWidget.selectedBackground': '#22301f',
      'input.background': '#0e130e',
      'input.border': '#243024',
      'scrollbarSlider.background': 'rgba(34, 197, 94, 0.2)',
      'scrollbarSlider.hoverBackground': 'rgba(34, 197, 94, 0.35)',
      'scrollbarSlider.activeBackground': 'rgba(34, 197, 94, 0.5)',
    },
  })

  monaco.editor.defineTheme('mssh-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1b2520',
      'editor.lineHighlightBackground': '#f0f4ef',
      'editorLineNumber.foreground': '#9aa79c',
      'editorLineNumber.activeForeground': '#6b7a6e',
      'editor.selectionBackground': 'rgba(22, 163, 74, 0.25)',
      'editor.inactiveSelectionBackground': 'rgba(22, 163, 74, 0.12)',
      'editorCursor.foreground': '#16a34a',
      'editorWhitespace.foreground': '#c9d4c8',
      'editorIndentGuide.background': '#e3e9e2',
      'editorIndentGuide.activeBackground': '#c9d4c8',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e3e9e2',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#e3e9e2',
      'editorSuggestWidget.selectedBackground': '#e2efe4',
      'input.background': '#fbfcfa',
      'input.border': '#e3e9e2',
      'scrollbarSlider.background': 'rgba(22, 163, 74, 0.2)',
      'scrollbarSlider.hoverBackground': 'rgba(22, 163, 74, 0.35)',
      'scrollbarSlider.activeBackground': 'rgba(22, 163, 74, 0.5)',
    },
  })
}

export function getMonacoTheme(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? 'mssh-dark' : 'mssh-light'
}

export { monaco }
