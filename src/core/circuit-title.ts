/** Accept a short name from the model, never a paragraph or an instruction. */
export function circuitTitleFromReply(reply: string): string {
  const line = reply.trim().split(/\r?\n/).find(value => value.trim()) ?? ''
  const title = line.replace(/^\s*(?:电路名称|项目名称|名称|标题|建议命名为)\s*[:：]?\s*/u, '')
    .replace(/^[`"'“”《》]+|[`"'“”《》]+$/gu, '').trim()
  if (title.length < 3 || title.length > 40 || /[。！？!?；;\r\n]/u.test(title)) throw new Error('AI 未返回简洁的电路名称，请重试。')
  return title
}
