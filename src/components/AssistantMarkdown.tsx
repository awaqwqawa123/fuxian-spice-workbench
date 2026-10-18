import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeAssistantMath } from '../assistantMath'

/** Render model prose without executing HTML or fetching model-supplied images. */
export default function AssistantMarkdown({ children, className = '' }: { children: string; className?: string }) {
  return <div className={`assistant-markdown ${className}`.trim()}>
    <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false }]]} skipHtml
      urlTransform={url => /^(https?:\/\/|mailto:|#)/i.test(url) ? url : ''}
      components={{
        a: ({ href, children }) => href
          ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span className="assistant-image-description">{alt || '图片'}</span>,
        table: ({ children }) => <div className="assistant-table-scroll"><table>{children}</table></div>,
      }}>
      {normalizeAssistantMath(children)}
    </Markdown>
  </div>
}
