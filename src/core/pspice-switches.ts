/** PSpice VSWITCH uses a smooth cubic interpolation of log resistance,
 * not ngspice SW's stateful hysteresis. Lower it to a native B conductance.
 * Reference: ngspice src/xspice/icm/xtradev/pswitch/cfunc.mod. */
const cardHeader=/^\.model\s+(\S+)\s+(VSWITCH|SW|ISWITCH|CS)\s*(.*)$/i
import { spiceModelName as identifier } from './spice-model-name'
interface SwitchCard {id:string;type:string;values:Map<string,number>;native?:string}
function number(raw:string):number {
  const match=raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|mil|[tgkmunpf]?)(?:[a-z]*)$/i)
  const scales:Record<string,number>={'':1,t:1e12,g:1e9,meg:1e6,mil:25.4e-6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
  const value=match?Number(match[1])*scales[match[2].toLowerCase()]:NaN
  if(!Number.isFinite(value))throw new Error(`PSpice 开关参数必须为有限常数：${raw}`)
  return value
}
export function isPspiceSwitchCard(line:string):boolean {return cardHeader.test(line)}
function parseCard(line:string):SwitchCard {
  const header=line.match(cardHeader)!
  if(!identifier.test(header[1]))throw new Error('PSpice 开关模型名称无效')
  let body=header[3].trim();if(body.startsWith('(')&&body.endsWith(')'))body=body.slice(1,-1).trim()
  const values=new Map<string,number>()
  while(body){
    const token=body.match(/^([a-z_]+)\s*=\s*([^\s,()]+)[\s,]*/i)
    if(!token)throw new Error(`PSpice 开关参数无法解析：${body.slice(0,80)}`)
    const key=token[1].toUpperCase()
    if(!['RON','ROFF','VON','VOFF','ION','IOFF','VT','VH','IT','IH'].includes(key)||values.has(key))throw new Error(`PSpice 开关参数 ${key} 不支持或重复；未删除原参数`)
    values.set(key,number(token[2]));body=body.slice(token[0].length)
  }
  const type=header[2].toUpperCase(),current=type==='ISWITCH'||type==='CS'
  const smooth=values.has(current?'ION':'VON')||values.has(current?'IOFF':'VOFF')||((type==='VSWITCH'||type==='ISWITCH')&&!values.has(current?'IT':'VT')&&!values.has(current?'IH':'VH'))
  const allowed=current?(smooth?['RON','ROFF','ION','IOFF']:['RON','ROFF','IT','IH']):(smooth?['RON','ROFF','VON','VOFF']:['RON','ROFF','VT','VH'])
  for(const key of values.keys())if(!allowed.includes(key))throw new Error(`PSpice 开关混合了不同类型的阈值：${key}`)
  if((values.get('RON')??1)<=0||(values.get('ROFF')??1e6)<=0)throw new Error('PSpice 开关 RON / ROFF 必须大于零')
  if((type==='SW'||type==='CS')&&smooth)throw new Error('原生 SW / CS 不接受 PSpice 平滑阈值参数')
  if(!smooth)return{id:header[1],type,values,native:`.model ${header[1]} ${current?'CS':'SW'}(${[...values].map(([key,value])=>`${key}=${value}`).join(' ')})`}
  const on=values.get(current?'ION':'VON')??1,off=values.get(current?'IOFF':'VOFF')??0
  if(on===off)throw new Error('PSpice 平滑开关的 ON / OFF 阈值相同，无法保持原插值语义')
  return{id:header[1],type,values}
}
/** Each call handles a single lexical scope. Local definitions shadow globals. */
export function normalizePspiceSwitches(lines:string[],globalCards:readonly string[]=[]):string[] {
  const local=new Map<string,SwitchCard>(),globals=new Map<string,SwitchCard>()
  const localIds=new Set<string>()
  for(const line of lines){const id=line.match(/^\.model\s+(\S+)/i)?.[1]?.toLowerCase();if(id){if(localIds.has(id))throw new Error(`内部模型 ${id} 重复`);localIds.add(id)}}
  const references=new Set(lines.filter(line=>/^[SW]\S*\s/i.test(line)).map(line=>{const parts=line.split(/\s+/);return parts[parts[0][0].toUpperCase()==='W'?4:5]?.toLowerCase()}))
  // An unsupported global auxiliary card must only reject roots that use it.
  for(const line of globalCards){const id=line.match(cardHeader)?.[1].toLowerCase();if(!id||lines.length>0&&(!references.has(id)||localIds.has(id)))continue;const card=parseCard(line),key=card.id.toLowerCase();if(globals.has(key))throw new Error(`开关模型 ${card.id} 重复`);globals.set(key,card)}
  for(const line of lines.filter(isPspiceSwitchCard)){const card=parseCard(line),key=card.id.toLowerCase();if(local.has(key))throw new Error(`开关模型 ${card.id} 重复`);local.set(key,card)}
  const ids=new Set(lines.filter(line=>!line.startsWith('.')).map(line=>line.split(/\s+/)[0].toLowerCase()))
  const usedGlobals=new Map<string,SwitchCard>(),out:string[]=[]
  for(const line of lines){
    if(isPspiceSwitchCard(line)){const card=local.get(line.split(/\s+/)[1].toLowerCase())!;if(card.native)out.push(card.native);continue}
    if(!/^[SW]\S*\s/i.test(line)){out.push(line);continue}
    const parts=line.trim().split(/\s+/),current=parts[0][0].toUpperCase()==='W',index=current?4:5,reference=parts[index],card=reference?(local.get(reference.toLowerCase())??globals.get(reference.toLowerCase())):undefined
    if(!card)throw new Error(`开关实例 ${parts[0]} 缺少自包含的开关模型 ${reference??''}`)
    if(current!==(card.type==='ISWITCH'||card.type==='CS'))throw new Error(`开关实例 ${parts[0]} 与模型类型不匹配`)
    if(parts.length!==index+1)throw new Error(`开关实例 ${parts[0]} 的初始状态或额外参数暂不支持；原文保留`)
    if(card.native){out.push(line);if(!local.has(card.id.toLowerCase()))usedGlobals.set(card.id.toLowerCase(),card);continue}
    const generated=`B__PS_${parts[0]}`
    if(ids.has(generated.toLowerCase()))throw new Error(`PSpice 兼容元件名称冲突：${generated}`)
    // Current through a renamed switch cannot be safely inferred by another
    // source. Reject such references instead of silently breaking the circuit.
    const escaped=parts[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    if(lines.some(other=>new RegExp(`\\bi\\(\\s*${escaped}\\s*\\)`,'i').test(other)||new RegExp(`^[FH]\\S*\\s+\\S+\\s+\\S+\\s+${escaped}(?:\\s|$)`,'i').test(other)))throw new Error(`PSpice 开关 ${parts[0]} 被电流控制源引用，暂不能等效转换`)
    const control=current?`i(${parts[3]})`:`v(${parts[3]},${parts[4]})`
    const on=card.values.get(current?'ION':'VON')??1,off=card.values.get(current?'IOFF':'VOFF')??0
    const t=`min(1,max(0,((${control})-(${off}))/(${on-off})))`
    const ron=card.values.get('RON')??1,roff=card.values.get('ROFF')??1e6
    const logR=`(${Math.log(roff)})+(${Math.log(ron)-Math.log(roff)})*(3*(${t})^2-2*(${t})^3)`
    out.push(`${generated} ${parts[1]} ${parts[2]} I={v(${parts[1]},${parts[2]})/exp(${logR})}`)
  }
  const end=out.findIndex(line=>/^\.ends\b/i.test(line));out.splice(end<0?out.length:end,0,...[...usedGlobals.values()].map(card=>card.native!))
  return out
}
