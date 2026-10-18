import {createHash} from 'node:crypto'
import {readFile,realpath,stat} from 'node:fs/promises'
import {isAbsolute,relative} from 'node:path'
import type {ImportedSpiceModel} from '../src/core/spice-models'
import {parseModelDeviceInfo} from '../src/core/model-device-info'
import {resolveModelFunctionalSymbol} from '../src/core/model-functional-symbol'

type Tree=string|Tree[]
/** PRP is an S-expression property file, not a SPICE model. Parse nesting so
 * PORT_ORDER cannot leak from another part, limits section or quoted string. */
export function parsePspiceDeviceProperties(text:string):Map<string,{labels?:string[];symbolName?:string}>{
  const tokens:string[]=[],pattern=/\(|\)|"(?:\\.|[^"\\])*"|;[^\r\n]*|[^()\s";]+/g
  let cursor=0
  for(const match of text.matchAll(pattern)){
    if(text.slice(cursor,match.index).trim())throw new Error('PSpice PRP 属性文字未闭合')
    cursor=match.index!+match[0].length
    if(!match[0].startsWith(';'))tokens.push(match[0])
  }
  if(text.slice(cursor).trim())throw new Error('PSpice PRP 属性文字未闭合')
  const roots:Tree[]=[],stack:Tree[][]=[roots]
  if(tokens.length>500000)throw new Error('PSpice PRP 属性文件过大')
  for(const token of tokens){
    if(token==='('){const next:Tree[]=[];stack[stack.length-1].push(next);stack.push(next)}
    else if(token===')'){if(stack.length===1)throw new Error('PSpice PRP 括号不平衡');stack.pop()}
    else stack[stack.length-1].push(token.startsWith('"')?token.slice(1,-1).replace(/\\(["\\])/g,'$1'):token)
    if(stack.length>32)throw new Error('PSpice PRP 嵌套过深')
  }
  if(stack.length!==1)throw new Error('PSpice PRP 括号不平衡')
  const result=new Map<string,{labels?:string[];symbolName?:string}>(),seen=new Set<string>()
  for(const root of roots){
    if(!Array.isArray(root)||typeof root[0]!=='string')continue
    const key=root[0].toUpperCase()
    if(seen.has(key)){result.delete(key);continue}seen.add(key)
    const info=root.filter(item=>Array.isArray(item)&&item[0]==='device_info') as Tree[][]
    if(info.length!==1)continue
    const rows=info[0].filter(item=>Array.isArray(item)&&item[0]==='PORT_ORDER') as Tree[][]
    const labels=rows.length===1?rows[0].slice(1).map(item=>Array.isArray(item)&&item.length===1&&typeof item[0]==='string'?item[0]:undefined):[]
    const symbols=info[0].filter(item=>Array.isArray(item)&&item[0]==='SYMBOL_NAME') as Tree[][]
    const symbolName=symbols.length===1&&symbols[0].length===2&&typeof symbols[0][1]==='string'?symbols[0][1]:undefined
    result.set(key,{...(labels.length&&labels.length<=64&&labels.every((item):item is string=>!!item&&item.length<=64&&!/[\x00-\x1f]/.test(item))?{labels:labels as string[]}:{}),...(symbolName?{symbolName}:{})})
  }
  return result
}
export function parsePspicePortOrders(text:string):Map<string,string[]>{return new Map([...parsePspiceDeviceProperties(text)].filter((entry):entry is [string,{labels:string[]}]=>!!entry[1].labels).map(([id,value])=>[id,value.labels]))}
const cache=new Map<string,{stamp:string;properties:ReturnType<typeof parsePspiceDeviceProperties>;hash:string;path:string}>()
export async function enrichPspicePortProperties(model:ImportedSpiceModel,modelPath:string,root:string):Promise<void>{
  if(model.kind!=='X')return
  try{
    const path=await realpath(modelPath.replace(/\.[^.\\/]+$/,'.prp')),rel=relative(root,path)
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))return
    const info=await stat(path);if(info.size>8*1024*1024)return
    const stamp=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    let entry=cache.get(path)
    if(entry?.stamp!==stamp){const bytes=await readFile(path);entry={stamp,properties:parsePspiceDeviceProperties(bytes.toString('utf8')),hash:createHash('sha256').update(bytes).digest('hex'),path:rel.replaceAll('\\','/')};cache.set(path,entry)}
    const property=entry.properties.get(model.id.toUpperCase())
    if(!property)return
    // The PRP registers an explicit functional symbol type. Restrict this to
    // known exact type names; arbitrary part names never establish a function.
    if(/^vcomp(?:[56])?$/i.test(property.symbolName??''))model.deviceInfo=parseModelDeviceInfo({...model.deviceInfo??{version:1,evidence:[]},function:'comparator',evidence:[...(model.deviceInfo?.evidence??[]).slice(0,7),{kind:'source-header',source:`PSpice 本地属性 / ${entry.path}`,sha256:entry.hash,text:`${model.id} device_info SYMBOL_NAME: ${property.symbolName}`} ]})
    const labels=property.labels
    if(!labels||labels.length!==model.pins.length)return
    const mapping={ports:[...model.pins],labels,source:`PSpice 本地属性 / ${entry.path}`,sha256:entry.hash,text:`${model.id} device_info PORT_ORDER: ${labels.join(' ')}`}
    model.deviceInfo=parseModelDeviceInfo({...model.deviceInfo??{version:1,evidence:[]},portMapping:mapping})
    // Existing original geometry wins. This fallback is explicitly standard.
    const symbol=resolveModelFunctionalSymbol(model)
    if(symbol)model.symbol=symbol
  }catch{/* Unreadable/malformed originals remain available without invented roles. */}
}
