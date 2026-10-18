/** Change one explicit constant without rewriting comments, metadata, or other parameters. */
export function replaceModelParameter(code:string,key:string,value:string):string {
  if(!/^[A-Z][A-Z0-9_]*$/i.test(key))throw new Error('模型参数名无效。')
  const trimmed=value.trim()
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(trimmed))throw new Error(`${key} 需要 SPICE 数值常数，例如 1.5、20n 或 1meg。`)
  // Mask comments with spaces to preserve exact offsets in the original text.
  const masked=code.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g,m=>' '.repeat(m.length)).replace(/^\s*\*[^\r\n]*/gm,m=>' '.repeat(m.length)).replace(/[;$][^\r\n]*/g,m=>' '.repeat(m.length))
  const lines=[...masked.matchAll(/[^\r\n]+/g)]
  let start=-1,end=-1
  for(const line of lines){
    if(/^\s*\.model\s/i.test(line[0])){if(start!==-1)throw new Error('每次只编辑一个 .model 定义。');start=line.index!;end=start+line[0].length}
    else if(start!==-1&&/^\s*\+/.test(line[0]))end=line.index!+line[0].length
  }
  if(start<0)throw new Error('未找到 .model 定义。')
  const section=masked.slice(start,end)
  const matches=[...section.matchAll(new RegExp(`\\b${key}\\s*=\\s*([^\\s(),]+)`,'gi'))]
  if(matches.length!==1)throw new Error(`${key} 必须在当前模型中明确且唯一地定义。`)
  const match=matches[0],offset=start+match.index!+match[0].length-match[1].length
  return code.slice(0,offset)+trimmed+code.slice(offset+match[1].length)
}
