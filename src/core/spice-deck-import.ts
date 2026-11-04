import { generateNetlist, newProject, parseProject, validateProject, type Project } from './circuit'
import { compileDrawing, emptyDrawing, parseDrawing, pinPosition, terminal, terminalKey, type Device, type DeviceKind, type Terminal } from './drawing'
import { parseSpiceLibrary, type ImportedSpiceModel } from './spice-models'
import { parseSpiceParameterAssignments, parseSubcircuitHeader, parseSubcircuitInstance, spiceNodeName, stripSpiceInlineComment } from './spice-parameters'
import { evaluateSourceExpression, parseSourceExpression } from './source-expression'
import { sourceValues } from './sources'
import { simulationSettings, type SimulationProfile } from './simulation-profiles'
import { deviceCatalog } from './devices'
import { terminalLeadDirection } from './wire-lead-route'

export interface SpiceDeckImportResult {
  project:Project; warnings:string[]
  /** Original identifiers, case folded, to editable identifiers. No inferred pin order. */
  references:Record<string,string>; nodeNames:Record<string,string>
}
interface Line {text:string;line:number}
interface Element {original:string;kind:DeviceKind;nodes:string[];value:string;params?:Record<string,string>;pins?:string[]}
const fail=(message:string):never=>{throw new Error(`SPICE 导入：${message}`)}
function number(raw:string):number {
  const m=raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-zµμ]*)$/i)
  if(!m)fail(`无法保留数值或表达式 ${raw}；请提供有限常数或可展开的 .param`)
  const suffix=m![2].toLowerCase().replace(/[µμ]/g,'u'),scales:Record<string,number>={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15,mil:25.4e-6}
  const unit=/^(?:v|a|hz|s|ohms?|f|h)$/i.test(suffix)&&suffix!=='f',prefix=suffix.startsWith('meg')?'meg':suffix.startsWith('mil')?'mil':suffix[0]
  const result=Number(m![1])*(suffix===''||unit?1:scales[prefix])
  if(!Number.isFinite(result))fail(`无法识别 SPICE 数值 ${raw}`)
  return result
}
const scalar=(text:string)=>String(number(text))
function source(raw:string,kind:'V'|'I'):{value:string;params:Record<string,string>} {
  let rest=raw.trim(),dc:string|undefined,params:Record<string,string>={waveform:'dc',acAmplitude:'0',acPhase:'0'}
  const wave=rest.match(/\b(SIN|SINE|PULSE|PWL)\s*\(([^()]*)\)/i)
  if(wave){
    const values=wave[2].trim().split(/[\s,]+/).filter(Boolean).map(scalar),name=wave[1].toLowerCase()
    if(name==='pulse'){
      if(values.length!==7)fail('PULSE 须明确提供 V1/V2/TD/TR/TF/PW/PER 七项；省略参数的仿真器默认值不能猜测')
      params={...params,waveform:'pulse',...Object.fromEntries(['low','high','delay','rise','fall','width','period'].map((key,i)=>[key,values[i]]))};dc=values[0]
    }else if(name==='pwl'){
      params={...params,waveform:'pwl',points:values.join(' ')};dc=values[1]
    }else{
      if(values.length<3||values.length>6||values[4]!==undefined&&Number(values[4])!==0)fail('SIN 支持偏置、幅度、频率、延迟和相位；非零阻尼暂不能完整导入')
      params={...params,waveform:'sine',offset:values[0],amplitude:values[1],frequency:values[2],delay:values[3]??'0',phase:values[5]??'0'}
      dc=String(Number(values[0])+Number(values[1])*Math.sin(Number(values[5]??0)*Math.PI/180))
    }
    rest=(rest.slice(0,wave.index)+rest.slice(wave.index!+wave[0].length)).trim()
  }
  const tokens=rest.split(/\s+/).filter(Boolean);let explicitDc=false,ac=false
  for(let i=0;i<tokens.length;){
    const token=tokens[i++].toUpperCase()
    if(token==='DC'){
      if(explicitDc||i===tokens.length)fail('DC 源参数缺少数值或重复')
      dc=scalar(tokens[i++]);explicitDc=true
    }else if(token==='AC'){
      if(ac||i===tokens.length)fail('AC 源参数缺少数值或重复')
      params.acAmplitude=scalar(tokens[i++]);ac=true
      if(i<tokens.length&&!/^(?:DC|AC)$/i.test(tokens[i]))params.acPhase=scalar(tokens[i++])
    }else if(i===1&&!explicitDc){dc=scalar(token);explicitDc=true}
    else fail(`不能保留源参数 ${token}`)
  }
  if(!raw.trim())fail('独立源缺少激励参数')
  const result={value:dc??'0',params};sourceValues({kind,...result});return result
}
/** A title and a digit-free SPICE identifier share the same lexical alphabet.
 * Use electrical syntax and declared dependencies, never the initial letter
 * alone. Explicit circuit-shaped IDs are records even when unsupported. */
function firstLineKind(text:string,deck:string):'title'|'device'|'ambiguous' {
  const parts=text.split(/\s+/),id=parts[0],kind=id[0]?.toUpperCase()
  if(!/^[a-z][a-z0-9_.+-]*$/i.test(id))return 'title'
  if(/[0-9_.+-]/.test(id))return 'device'
  const declarations=new Set([...deck.matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)].map(match=>match[1].toLowerCase()))
  const constant=(value:string|undefined)=>{
    if(!value)return false
    if(/^[{'"]/.test(value))return true
    try{number(value);return true}catch{return false}
  }
  const declared=(value:string|undefined)=>value!==undefined&&declarations.has(value.toLowerCase())
  const grounded=parts.slice(1,3).includes('0')
  if(['R','C','L'].includes(kind))return constant(parts[3])||declared(parts[3])?'device':grounded?'ambiguous':'title'
  if(kind==='V'||kind==='I')return constant(parts[3])||/^(?:DC|AC|SIN|SINE|PULSE|PWL|EXP|SFFM|AM|TRNOISE|TRRANDOM)(?:\b|\()/i.test(parts[3]??'')||/^[VI]=/i.test(parts[3]??'')?'device':grounded?'ambiguous':'title'
  if(['D','Q','M','J'].includes(kind)){
    const positions=kind==='D'?[3]:kind==='J'?[4]:[4,5]
    if(positions.some(index=>declared(parts[index])))return 'device'
    // The trailing word could be an unavailable model or an ordinary title
    // word. Neither silently dropping a device nor guessing a model is safe.
    return parts.length>Math.min(...positions)?'ambiguous':'title'
  }
  if(kind==='X'){
    try{return declarations.has(parseSubcircuitInstance(text).target.toLowerCase())?'device':'ambiguous'}catch{return grounded?'ambiguous':'title'}
  }
  if(kind==='B')return /^[VI]\s*=/i.test(parts.slice(3).join(' '))?'device':grounded?'ambiguous':'title'
  if(kind==='E'||kind==='G')return parts.length===6&&constant(parts[5])?'device':grounded?'ambiguous':'title'
  if(kind==='F'||kind==='H')return parts.length===5&&constant(parts[4])?'device':grounded?'ambiguous':'title'
  if((kind==='S'||kind==='W')&&parts.slice(3).some(declared))return 'device'
  return parts.length>=4&&constant(parts[3])?'ambiguous':'title'
}
function readLines(text:string):{lines:Line[];title:string} {
  const lines:Line[]=[];let title='导入 SPICE 电路',ended=false,first=true
  for(const [index,raw]of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
    const clean=stripSpiceInlineComment(raw.trim())
    if(!clean||clean.startsWith('*'))continue
    if(first){
      first=false
      if(!clean.startsWith('.')){
        const form=firstLineKind(clean,text)
        if(form==='ambiguous')fail(`第 ${index+1} 行首行既可能是标题，也可能是纯字母编号 ${clean.split(/\s+/)[0]} 的器件语句：${clean}。请在文件前添加显式 .title 标题指令，或将器件改为含数字或下划线的明确编号；未忽略该行`)
        if(form==='title'){title=clean.slice(0,80);continue}
      }
    }
    if(ended)fail(`第 ${index+1} 行：.end 后还有内容，不能导入多个独立电路段`)
    if(/^\.end\s*$/i.test(clean)){ended=true;continue}
    if(clean.startsWith('+')){if(!lines.length)fail(`第 ${index+1} 行：续行前缺少语句`);lines.at(-1)!.text+=' '+clean.slice(1).trim()}
    else lines.push({text:clean,line:index+1})
  }
  return {lines,title}
}
/** Global constants are evaluated with the bounded arithmetic parser, never JavaScript. */
function expandParameters(lines:Line[]):Line[] {
  const definitions=new Map<string,string>();let depth=0
  for(const entry of lines){
    if(/^\.subckt\b/i.test(entry.text)){depth++;continue}
    if(/^\.ends\b/i.test(entry.text)){depth--;continue}
    if(depth||!/^\.param\b/i.test(entry.text))continue
    const parsed=parseSpiceParameterAssignments(entry.text.replace(/^\.param\s*/i,''))
    if(!parsed.length)fail(`第 ${entry.line} 行 .param 缺少赋值`)
    for(const p of parsed){const key=p.name.toLowerCase();if(definitions.has(key))fail(`全局参数 ${p.name} 重复`);definitions.set(key,p.value);if(definitions.size>128)fail('全局 .param 超过 128 个参数限制')}
  }
  const constants=new Map<string,string>(),pending=new Set<string>()
  function evaluate(name:string):string {
    if(constants.has(name))return constants.get(name)!
    if(pending.has(name))fail(`全局 .param ${name} 循环引用`)
    const expression=definitions.get(name);if(expression===undefined)fail(`全局 .param 引用未声明参数 ${name}`)
    pending.add(name)
    const expanded=expression!.replace(/^\{(.*)\}$/,'$1').replace(/\b[a-z_][a-z0-9_]*\b/gi,(token,offset,whole)=>{
      const key=token.toLowerCase()
      if(definitions.has(key))return `(${evaluate(key)})`
      if(key==='e')return String(Math.E)
      if(/^(time|temp|temper)$/i.test(key))fail(`全局参数 ${name} 引用了上下文 ${token}，不能作为常数展开`)
      return token
    })
    let value:number
    try{value=evaluateSourceExpression(parseSourceExpression(expanded.replace(/\*\*/g,'^')),0)}catch(error){fail(`全局参数 ${name} 无法安全展开：${(error as Error).message}`)}
    pending.delete(name);constants.set(name,String(value!));return String(value!)
  }
  for(const key of definitions.keys())evaluate(key)
  const result:Line[]=[];depth=0
  for(let i=0;i<lines.length;i++){
    const entry={...lines[i]}
    if(/^\.subckt\b/i.test(entry.text)){
      depth++;const header=parseSubcircuitHeader(entry.text),shadow=new Set(header.parameters.map(p=>p.name.toLowerCase()))
      for(let j=i+1;j<lines.length&&!/^\.ends\b/i.test(lines[j].text);j++)if(/^\.param\b/i.test(lines[j].text))for(const p of parseSpiceParameterAssignments(lines[j].text.replace(/^\.param\s*/i,'')))shadow.add(p.name.toLowerCase())
      entry.text=entry.text.replace(/\{([^{}]+)\}/g,(_,expr:string)=>'{'+expr.replace(/\b[a-z_][a-z0-9_]*\b/gi,token=>!shadow.has(token.toLowerCase())&&constants.has(token.toLowerCase())?`(${constants.get(token.toLowerCase())})`:token)+'}')
      result.push(entry)
      const global=[...constants].filter(([key])=>!shadow.has(key)).map(([key,value])=>`${key}=${value}`)
      if(global.length)result.push({text:'.param '+global.join(' '),line:entry.line})
      continue
    }
    if(/^\.ends\b/i.test(entry.text)){depth--;result.push(entry);continue}
    if(depth){result.push(entry);continue}
    if(/^\.param\b/i.test(entry.text))continue
    entry.text=entry.text.replace(/\{([^{}]+)\}/g,(original,expr:string)=>{
      // Behavioral sources may contain time and circuit probes. Substitute constants without evaluating the behavior.
      const expanded=expr.split(/(\b[vi]\s*\([^()]*\))/gi).map(segment=>/^\b[vi]\s*\(/i.test(segment)?segment:segment.replace(/\b[a-z_][a-z0-9_]*\b/gi,token=>constants.has(token.toLowerCase())?`(${constants.get(token.toLowerCase())})`:token)).join('')
      if(/^[BEG]/i.test(entry.text))return '{'+expanded+'}'
      try{return String(evaluateSourceExpression(parseSourceExpression(expanded.replace(/\*\*/g,'^')),0))}catch(error){return fail(`第 ${entry.line} 行参数表达式无法展开：${(error as Error).message}`)}
    })
    result.push(entry)
  }
  return result
}

/** Import a decoded, dependency-expanded LTspice/PSpice text deck atomically. */
export function importSpiceDeck(text:string,options:{title?:string;sourceName?:string}={}):SpiceDeckImportResult {
  if(typeof text!=='string'||text.length>1024*1024||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))fail('仅接受 1 MB 以内的纯文本仿真网表；二进制、加密文件不能作为文本读取')
  const read=readLines(text),lines=expandParameters(read.lines),library:Line[]=[],top:Line[]=[],warnings:string[]=[];let depth=0
  for(const entry of lines){
    if(/^\.subckt\b/i.test(entry.text))depth++
    if(depth||/^\.model\b/i.test(entry.text))library.push(entry);else top.push(entry)
    if(/^\.ends\b/i.test(entry.text)){if(!depth)fail(`第 ${entry.line} 行 .ends 没有 .subckt`);depth--}
  }
  if(depth)fail('.subckt 缺少 .ends')
  const attribution={label:options.sourceName?.slice(0,200)||'导入仿真文件'},libraryText=library.map(l=>l.text).join('\n')
  const preview=parseSpiceLibrary(libraryText,attribution)
  const errors=preview.diagnostics.filter(d=>d.severity==='error')
  if(errors.length)fail(`模型定义不能完整保留：${errors.map(d=>`${d.model??''} ${d.message}`).join('；')}`)
  warnings.push(...preview.diagnostics.filter(d=>d.severity==='warning').map(d=>d.message))
  const modelById=new Map(preview.models.map(model=>[model.id.toLowerCase(),model])),models=[...preview.models],elements:Element[]=[],directives:Line[]=[],seen=new Set<string>()
  const wrapper=(entry:Line,nodes:string[],body:string,dependency?:ImportedSpiceModel|string):Element=>{
    let serial=models.length+1,id=`DECK_DEVICE_${serial}`;while(modelById.has(id.toLowerCase()))id=`DECK_DEVICE_${++serial}`
    const pins=nodes.map((_,i)=>`p${i+1}`)
    const result=parseSpiceLibrary([`.subckt ${id} ${pins.join(' ')}`,body,typeof dependency==='string'?dependency:dependency?.spice??'',`.ends ${id}`].join('\n'),attribution)
    const error=result.diagnostics.filter(d=>d.severity==='error'),model=result.models.find(model=>model.id===id)
    if(error.length||!model)fail(`第 ${entry.line} 行 ${entry.text.split(/\s/)[0]} 无法保留：${error.map(d=>d.message).join('；')}`)
    models.push(model!);modelById.set(id.toLowerCase(),model!)
    warnings.push(`${entry.text.split(/\s/)[0]} 以子电路适配器保留原始端序、模型及实例参数，可在模型栏查看源码。`)
    return {original:entry.text.split(/\s/)[0],kind:'X',nodes,value:id,pins}
  }
  for(const entry of top){
    const tokens=entry.text.split(/\s+/),original=tokens[0],letter=original[0]?.toUpperCase()
    if(original.startsWith('.')){directives.push(entry);continue}
    if(seen.has(original.toLowerCase()))fail(`第 ${entry.line} 行器件编号 ${original} 重复，无法确定连接引用`)
    seen.add(original.toLowerCase())
    if(!/^[a-z][a-z0-9_.+-]*$/i.test(original))fail(`第 ${entry.line} 行器件编号 ${original} 无效`)
    if(['R','C','L'].includes(letter)){
      const value=tokens.length===4?number(tokens[3]):undefined,range=letter==='R'?[.01,1e9]:letter==='C'?[1e-12,1]:[1e-9,1e3]
      if(value!==undefined&&value>=range[0]&&value<=range[1])elements.push({original,kind:letter as DeviceKind,nodes:tokens.slice(1,3),value:String(value)})
      else {
        const dependency=library.filter(line=>/^\.model\s+\S+\s+R\s*\(/i.test(line.text)).map(line=>line.text).join('\n')
        elements.push(wrapper(entry,tokens.slice(1,3),`${original} p1 p2 ${tokens.slice(3).join(' ')}`,dependency))
      }
    }else if(letter==='V'||letter==='I')elements.push({original,kind:letter,nodes:tokens.slice(1,3),...source(tokens.slice(3).join(' '),letter)})
    else if(letter==='X'){
      const instance=parseSubcircuitInstance(entry.text),model=modelById.get(instance.target.toLowerCase())
      if(!model||model.kind!=='X')fail(`${original} 引用缺失的 .subckt ${instance.target}；请一并提供外部依赖文件`)
      if(instance.pins.length!==model!.pins.length)fail(`${original} 的 ${instance.pins.length} 个端口与 .subckt ${instance.target} 的 ${model!.pins.length} 个端口不一致`)
      elements.push({original,kind:'X',nodes:instance.pins,value:model!.id,pins:model!.pins,params:Object.fromEntries(instance.parameters.map(p=>[p.name,p.value]))})
    }else if(['D','Q','M','J'].includes(letter)){
      let index=letter==='D'?3:letter==='J'?4:letter==='M'?5:4
      if(letter==='Q'){
        const candidates=[4,5].filter(i=>modelById.get(tokens[i]?.toLowerCase())?.kind==='Q')
        if(candidates.length!==1)fail(`${original} 无法唯一确定 BJT 模型及 3/4 端序；候选模型 ${tokens.slice(4,6).join(' / ')}`)
        index=candidates[0]
      }
      if(letter==='M'&&modelById.get(tokens[4]?.toLowerCase())?.technology==='VDMOS')index=4
      const model=modelById.get(tokens[index]?.toLowerCase())
      if(!model||model.kind!==letter)fail(`${original} 引用缺失或类型不匹配的 .model ${tokens[index]??'（缺失）'}；请提供实际模型文件，不能用通用模型替代`)
      const nodes=tokens.slice(1,index)
      if((letter!=='M'&&index===(letter==='D'?3:4)||letter==='M'&&model!.technology==='VDMOS')&&tokens.length===index+1)elements.push({original,kind:letter as DeviceKind,nodes,value:model!.id})
      else elements.push(wrapper(entry,nodes,`${original} ${nodes.map((_,i)=>`p${i+1}`).join(' ')} ${model!.id} ${tokens.slice(index+1).join(' ')}`,model!))
    }else if(letter==='E'||letter==='G'){
      if(tokens.length!==6)fail(`${original} 的受控源形式尚不支持完整导入；仅接受明确四节点和常数增益的 E/G`)
      const nodes=tokens.slice(1,5);elements.push(wrapper(entry,nodes,`${original} p1 p2 p3 p4 ${scalar(tokens[5])}`))
    }else if(letter==='B'){
      const nodes=tokens.slice(1,3),tail=tokens.slice(3).join(' ')
      if(!/^[VI]\s*=/i.test(tail)||/\bi\s*\(/i.test(tail))fail(`${original} 的行为源包含不支持的支路电流引用或表达式`)
      const body=tail.replace(/\bv\s*\(\s*([^(),\s]+)\s*(?:,\s*([^(),\s]+)\s*)?\)/gi,(_,a:string,b?:string)=>{
        const pin=(node:string)=>{if(node==='0')return '0';let i=nodes.findIndex(n=>n.toLowerCase()===node.toLowerCase());if(i<0){nodes.push(node);i=nodes.length-1}return `p${i+1}`}
        return `v(${pin(a)}${b!==undefined?','+pin(b):''})`
      })
      elements.push(wrapper(entry,nodes,`${original} p1 p2 ${body}`))
    }else fail(`第 ${entry.line} 行不支持的器件 ${original}（${letter==='F'||letter==='H'?'外部控制电压源电流引用无法安全迁入独立适配器':'未删减原语句'}）`)
  }
  if(!elements.length||elements.length>79)fail('可编辑导入需要 1～79 个顶层器件，另预留一个接地符号')
  // A vendor library is a lookup source, not the project's device inventory.
  // Imported X records already contain their validated recursive dependency
  // closure; retaining the referenced root preserves those definitions without
  // independently embedding every public record from the supplied library.
  const referencedModelIds=new Set(elements.filter(e=>['D','Q','M','J','X'].includes(e.kind)).map(e=>e.value.toLowerCase()))
  const projectModels=models.filter(model=>referencedModelIds.has(model.id.toLowerCase()))
  if(projectModels.length>128)fail('实际引用模型及器件适配器合计超过工程的 128 个模型限制')
  const embeddedDefinitionIds=new Set(projectModels.flatMap(model=>[...model.spice.matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)].map(match=>match[1].toLowerCase())))
  const unusedModels=preview.models.filter(model=>!embeddedDefinitionIds.has(model.id.toLowerCase()))
  if(unusedModels.length)warnings.push(`提供的模型库中 ${unusedModels.length} 个未引用模型未嵌入工程；实际引用子电路及其递归依赖已保留，原来源为 ${attribution.label}。`)
  const references:Record<string,string>=Object.create(null),nodeNames:Record<string,string>=Object.create(null),assigned=new Set<string>()
  for(const e of elements)if(new RegExp(`^${deviceCatalog[e.kind].prefix}[1-9]\\d{0,4}$`,'i').test(e.original)){references[e.original.toLowerCase()]=e.original.toUpperCase();assigned.add(e.original.toUpperCase())}
  for(const e of elements){
    if(!references[e.original.toLowerCase()]){const prefix=deviceCatalog[e.kind].prefix;let n=1;while(assigned.has(`${prefix}${n}`))n++;const id=`${prefix}${n}`;references[e.original.toLowerCase()]=id;assigned.add(id);warnings.push(`器件编号 ${e.original} 映射为 ${id}。`)}
    if(e.nodes.length<2||e.nodes.some(n=>!spiceNodeName.test(n)))fail(`${e.original} 含有不支持或缺失的实际节点`)
  }
  const nodes=[...new Set(elements.flatMap(e=>e.nodes.map(n=>n.toLowerCase())))],usedNames=new Set(nodes.filter(n=>/^[a-z_][a-z0-9_]{0,31}$/i.test(n)))
  for(const node of nodes){
    if(node==='0'){nodeNames[node]='0';continue}
    if(/^[a-z_][a-z0-9_]{0,31}$/i.test(node))nodeNames[node]=node
    else{let n=1;while(usedNames.has(`deck_net_${n}`))n++;nodeNames[node]=`deck_net_${n}`;usedNames.add(nodeNames[node]);warnings.push(`节点 ${node} 映射为 ${nodeNames[node]}。`)}
  }
  if(!nodes.includes('0'))fail('缺少实际参考节点 0；不能猜测接地点')
  const analyses=directives.filter(entry=>/^\.(op|ac|tran|dc|noise)\b/i.test(entry.text))
  if(analyses.length>24)fail('分析指令超过 24 个仿真配置限制')
  const noiseSources=analyses.filter(entry=>/^\.noise\b/i.test(entry.text)).map(entry=>entry.text.split(/\s+/)[2].toLowerCase())
  const reference=elements.find(e=>e.original.toLowerCase()===noiseSources[0]&&e.kind==='V'&&e.nodes[1]==='0')??elements.find(e=>e.kind==='V'&&e.nodes[1]==='0'&&Number(e.params?.acAmplitude)>0)??elements.find(e=>e.kind==='V'&&e.nodes[1]==='0')
  if(!reference)return fail('当前可编辑工程需要一个负端实际接节点 0 的独立电压源作为输入参考；该文件仅含浮地源或电流源，未添加虚构电源')
  const p:Project={...newProject(),schemaVersion:2,template:'custom',title:(options.title??read.title).slice(0,80),analysis:'op',models:projectModels,drawing:emptyDrawing()}
  const drawing=p.drawing!,groups=new Map<string,Terminal[]>();drawing.sourceId=references[reference.original.toLowerCase()]
  // Group source-connected signal paths and shunts; common ground never pulls all parts into a single layer.
  const distance=new Map<string,number>([[reference.nodes[0].toLowerCase(),0]]);let changed=true
  while(changed){changed=false;for(const e of elements){if(e.kind==='V'||e.kind==='I')continue;const present=e.nodes.filter(n=>n!=='0').map(n=>distance.get(n.toLowerCase())).filter((n):n is number=>n!==undefined);if(!present.length)continue;for(const n of e.nodes)if(n!=='0'&&!distance.has(n.toLowerCase())){distance.set(n.toLowerCase(),Math.min(...present)+1);changed=true}}}
  const levelCount=new Map<number,number>(),rowSpacing=Math.max(260,...elements.map(e=>(e.pins?.length??0)*20+160))
  for(const [index,e]of elements.entries()){
    const level=e===reference?0:Math.min(...e.nodes.filter(n=>n!=='0').map(n=>distance.get(n.toLowerCase())??6))+1,row=levelCount.get(level)??0;levelCount.set(level,row+1)
    const left=Math.ceil((e.pins?.length??0)/2)
    const device:Device={id:references[e.original.toLowerCase()],kind:e.kind,value:e.value,x:160+(level%7)*400,y:120+row*rowSpacing+Math.floor(level/7)*1560,rotation:0,...(e.params?{params:e.params}:{}),...(e.pins?{pins:e.pins,pinPositions:e.pins.map((_,pin)=>({x:pin<left?-60:60,y:((pin<left?pin:pin-left)-(left-1)/2)*40}))}:{})}
    drawing.devices.push(device)
    e.nodes.forEach((node,pin)=>{const name=node.toLowerCase();groups.set(name,[...(groups.get(name)??[]),terminal(device.id,pin)])})
  }
  let groundLabel='deck_ground';while(usedNames.has(groundLabel))groundLabel+='_g'
  drawing.devices.push({id:'G1',kind:'GND',value:'',x:80,y:80,rotation:0});groups.get('0')!.push(terminal('G1'))
  let label=1,junction=1,wire=1
  for(const [node,terminals]of groups){
    const name=node==='0'?groundLabel:nodeNames[node]
    for(const at of terminals){
      if('device'in at&&at.device==='G1'){drawing.labels!.push({id:`N${label++}`,name,at});continue}
      while(assigned.has(`J${junction}`))junction++
      const device=drawing.devices.find(d=>'device'in at&&d.id===at.device)!,pos=pinPosition(device,'device'in at?at.pin:0),direction=terminalLeadDirection(drawing,at)!,id=`J${junction++}`
      drawing.junctions.push({id,x:pos.x+direction.x*40,y:pos.y+direction.y*40})
      drawing.wires.push({id:`W${wire++}`,from:at,to:{junction:id},bend:'hv'})
      drawing.labels!.push({id:`N${label++}`,name,at:{junction:id}})
    }
  }
  if(drawing.labels!.length>100)fail('该网表的独立引脚网标超过当前可编辑工程 100 个标签限制；未丢弃节点或连接')
  const endpoint=(node:string):Terminal=>{const at=groups.get(node.toLowerCase())?.[0];if(!at)fail(`引用了电路中不存在的节点 ${node}`);return at!}
  const defaultOutput=nodes.find(n=>/^(?:v?out|output)$/i.test(n))??nodes.find(n=>n!=='0'&&n!==reference.nodes[0].toLowerCase())??reference.nodes[0]
  drawing.output=endpoint(defaultOutput)
  const settings:Line[]=directives.filter(entry=>!analyses.includes(entry))
  for(const entry of settings){
    const a=entry.text.split(/\s+/),command=a[0].toLowerCase()
    if(['.probe','.print','.plot','.save','.backanno','.title'].includes(command)){
      if(command==='.title'){p.title=entry.text.replace(/^\.title\s*/i,'').slice(0,80);continue}
      warnings.push(`${a[0]} 是显示、输出或回标设置；原软件曲线选择未恢复，可在工作台重新选择。`)
    }else if(command==='.temp'&&a.length===2)p.temperature=number(a[1])
    else if(command==='.options'||command==='.option'){
      const options:Record<string,string>={}
      for(const token of entry.text.replace(/^\.options?\s*/i,'').replace(/\s*=\s*/g,'=').split(/\s+/)){
        const pair=token.match(/^(method|maxord|reltol|abstol|vntol|chgtol|gmin|trtol|itl1|itl4)=(\S+)$/i)
        if(!pair)fail(`第 ${entry.line} 行不支持求解器选项 ${token}`)
        options[pair![1].toLowerCase()]=pair![1].toLowerCase()==='method'?pair![2].toLowerCase():scalar(pair![2])
      }
      p.solver={...p.solver,...options} as Project['solver']
    }else if(command==='.ic'||command==='.nodeset'){
      const field=command==='.ic'?'initialConditions':'nodeSets',content=entry.text.replace(/^\.(ic|nodeset)\s*/i,'').replace(/\s*=\s*/g,'=')
      for(const token of content.split(/\s+/)){const pair=token.match(/^v\(([^(),]+)\)=(\S+)$/i);if(!pair)fail(`节点电压设置无法保留：${token}`);p[field]=[...(p[field]??[]),{at:endpoint(pair![1]),value:scalar(pair![2])}]}
    }else fail(`第 ${entry.line} 行指令 ${a[0]} 无法完整保留：${entry.text}${/^\.(inc|include|lib)\b/i.test(entry.text)?'；请一并导入所引用的外部模型文件':''}`)
  }
  const profiles:SimulationProfile[]=[]
  for(const [index,entry]of (analyses.length?analyses:[{text:'.op',line:0}]).entries()){
    const q=structuredClone(p),a=entry.text.split(/\s+/),command=a[0].toLowerCase();q.analysis=command.slice(1) as Project['analysis']
    if(command==='.op'&&a.length===1){}
    else if(command==='.ac'&&a.length===5&&/^(dec|oct|lin)$/i.test(a[1]))q.ac={points:number(a[2]),start:scalar(a[3]),stop:scalar(a[4]),sweep:a[1].toLowerCase() as 'dec'|'oct'|'lin'}
    else if(command==='.dc'&&a.length===5){const id=references[a[1].toLowerCase()];if(!id||!q.drawing!.devices.some(d=>d.id===id&&(d.kind==='V'||d.kind==='I')))fail(`.dc 引用缺失的独立源 ${a[1]}`);q.dc={start:scalar(a[2]),stop:scalar(a[3]),step:scalar(a[4]),sourceId:id}}
    else if(command==='.tran'){
      const uic=/^uic$/i.test(a.at(-1)!),values=a.slice(1,uic?-1:undefined).map(number)
      if(values.length<1||values.length>4)fail(`TRAN 的 STARTUP、调试参数或格式不能完整保留：${entry.text}`)
      const stop=values.length===1?values[0]:values[1],step=values.length===4?values[3]:values.length>=2&&values[0]>0?values[0]:stop/2000
      q.tran={stop:String(stop),step:String(step),...(values.length>=3?{start:String(values[2])}:{}),...(values.length>=2&&values[0]>0?{outputStep:String(values[0])}:{}),...(uic?{uic:true}:{})}
      if(values.length===1||values[0]===0&&values.length<4)warnings.push(`TRAN 未给出最大步长，按工作台设置采用 ${step} s；请核对采样精度。`)
    }else if(command==='.noise'&&(a.length===7||a.length===8)){
      const output=a[1].match(/^v\(([^(),]+)(?:,([^(),]+))?\)$/i),input=references[a[2].toLowerCase()]
      if(!output||!/^(dec|oct|lin)$/i.test(a[3])||!input||!q.drawing!.devices.some(d=>d.id===input&&d.kind==='V'))fail(`NOISE 输出、输入源或扫描形式不能完整保留：${entry.text}`)
      q.drawing!.sourceId=input;q.drawing!.output=endpoint(output![1]);q.noise={...(output![2]&&output![2]!=='0'?{negative:endpoint(output![2])}:{}),...(a[7]?{summaryInterval:number(a[7])}:{})};q.ac={points:number(a[4]),start:scalar(a[5]),stop:scalar(a[6]),sweep:a[3].toLowerCase() as 'dec'|'oct'|'lin'}
    }else fail(`分析指令不能完整保留：${entry.text}`)
    const errors=validateProject(q);if(errors.length)fail(`${entry.text} 无法在当前可编辑工程中执行：${errors.join('；')}`)
    profiles.push({id:`import_${index+1}`,name:entry.text.slice(0,80),settings:simulationSettings(q)})
    if(index===0)Object.assign(p,q)
  }
  p.waveformSetup={version:1,profiles:{version:1,activeId:profiles[0].id,profiles},diagrams:[]}
  if(!analyses.length)warnings.push('文件没有分析指令，已选择直流工作点。')
  p.drawing=parseDrawing(p.drawing);const replay=parseProject(JSON.parse(JSON.stringify(p)))
  generateNetlist(replay)
  // Check every top-level terminal after serialization, including numeric-node renaming and repeated ports.
  const compiled=compileDrawing(replay.drawing!)
  for(const e of elements)e.nodes.forEach((node,pin)=>{const actual=compiled.nodes.get(terminalKey(terminal(references[e.original.toLowerCase()],pin)));if(actual!==nodeNames[node.toLowerCase()])fail(`${e.original} 第 ${pin+1} 引脚网络恢复不一致：${actual} / ${node}`)})
  warnings.push('文本网表不含原始图面；已按输入通路与支路生成可编辑布局，同名网标表示真实同网连接，请审阅图面。')
  return {project:replay,warnings:[...new Set(warnings)],references,nodeNames}
}
