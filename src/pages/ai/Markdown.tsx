import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider'

/** 行内语法：`code` / **bold** / *italic* / [link](url)（纯 React 渲染，不注入 HTML） */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\n]+\*)/g
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-${i++}`
    if (tok.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="mx-0.5 px-1 py-0.5 rounded bg-soft border border-bd/70 font-mono text-[12px] text-accent"
        >
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-fg">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else if (tok.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
      if (link) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="text-info hover:underline"
          >
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(tok)
      }
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 代码块：语言标识 + 一键复制按钮 */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  async function doCopy() {
    try {
      await window.api.clipboardWriteText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默
    }
  }

  return (
    <div className="my-2 rounded-md border border-bd bg-input overflow-hidden">
      <div className="flex items-center justify-between h-7 px-2.5 bg-soft border-b border-bd">
        <span className="text-[11px] text-dim font-mono">{lang || 'shell'}</span>
        <button
          onClick={doCopy}
          title={t('ai.copyCode')}
          className={`flex items-center gap-1 h-5 px-1.5 rounded text-[11px] transition-colors ${
            copied ? 'text-accent' : 'text-dim hover:text-fg hover:bg-hover'
          }`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('ai.copied') : t('ai.copy')}
        </button>
      </div>
      <pre className="px-3 py-2 text-xs leading-relaxed font-mono overflow-x-auto selectable text-term-fg">
        <code>{code.replace(/\n$/, '')}</code>
      </pre>
    </div>
  )
}

/** 解析普通 Markdown 文本段（代码围栏之外）为块级元素 */
function renderBlocks(text: string): ReactNode {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 标题
    const head = /^(#{1,6})\s+(.*)$/.exec(line)
    if (head) {
      const level = head[1].length
      const content = renderInline(head[2], `h${key}`)
      const cls =
        level <= 2
          ? 'text-[15px] font-semibold text-fg mt-3 mb-1.5'
          : 'text-[13.5px] font-semibold text-fg mt-2.5 mb-1'
      blocks.push(
        level === 1 ? (
          <h1 key={key++} className={cls}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={key++} className={cls}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={key++} className={cls}>{content}</h3>
        ) : (
          <h4 key={key++} className={cls}>{content}</h4>
        ),
      )
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-2 pl-3 border-l-2 border-bd-strong text-dim selectable"
        >
          {renderInline(quote.join(' '), `q${key}`)}
        </blockquote>,
      )
      continue
    }

    // 无序列表
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="my-1.5 pl-5 list-disc space-y-1 marker:text-faint selectable">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="my-1.5 pl-5 list-decimal space-y-1 marker:text-faint selectable">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // 水平线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key++} className="my-3 border-bd" />)
      i++
      continue
    }

    // 普通段落：聚合连续文本行，段内换行保留为 <br/>
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={key++} className="my-1.5 selectable">
        {para.map((l, idx) => (
          <span key={idx}>
            {idx > 0 && <br />}
            {renderInline(l, `p${key}-${idx}`)}
          </span>
        ))}
      </p>,
    )
  }

  return <>{blocks}</>
}

/** 轻量 Markdown 渲染：代码围栏（带复制按钮）+ 常见块级/行内语法 */
export function Markdown({ content }: { content: string }) {
  if (!content) return null

  // 按 ``` 切分：偶数段为普通文本，奇数段为代码块（首行可带语言标识）
  const parts = content.split('```')
  return (
    <div className="text-[13px] leading-relaxed text-fg break-words">
      {parts.map((part, idx) => {
        if (idx % 2 === 0) {
          return <div key={idx}>{renderBlocks(part)}</div>
        }
        const nl = part.indexOf('\n')
        const lang = (nl >= 0 ? part.slice(0, nl) : '').trim()
        const code = nl >= 0 ? part.slice(nl + 1) : part
        return <CodeBlock key={idx} lang={lang} code={code} />
      })}
    </div>
  )
}
