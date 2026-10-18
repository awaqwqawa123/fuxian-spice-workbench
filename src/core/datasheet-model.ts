import type { DatasheetText } from './datasheet-text'
import type { ImportedModelType } from './spice-models'
import { hasUnreadableDatasheetText } from './datasheet-encoding'
import { spiceParameterNumber, equivalentModelParameterValues } from './model-parameter-values'
import { fitDiodeForwardPoints, type DiodeForwardPoint } from './datasheet-diode-fit'

export interface DatasheetParameter {
  id: string; page: number; label: string; key?: string; value: string; evidence: string; note: string; basis: string
  quote?:string; conditions?:string
  citations?:{page:number;quote:string}[]
  curvePoint?:DiodeForwardPoint
}
/** A recognized unsupported family must never inherit the default diode template. */
export function unsupportedDatasheetReason(document: DatasheetText): string | undefined {
  const text = document.pages.slice(0, 3).map(page => page.text).join('\n')
  const identity=text.split('\n').filter(line=>!/applications?|typical\s+circuit|used\s+(?:in|for)|suitable\s+for/i.test(line)).slice(0,16).join('\n')
  if (/programmable\s+precision\s+reference|programmable\s+(?:voltage\s+)?reference|adjustable\s+shunt\s+(?:regulator|reference)|可调.{0,12}(?:基准|分流稳压)/i.test(text)
    || (/\bshunt\s+regulator\b/i.test(text) && /\b(?:reference|three[-\s]?terminal|cathode)\b/i.test(text)))
    return '这是可调精密基准或分流稳压器，具有 REF、阴极和阳极等引脚；现有二极管等单器件模板不能表示其反馈调节行为。'
  if (/\boperational\s+amplifiers?\b|\bop[-\s]?amps?\b|运算放大器/i.test(text))
    return '这是运算放大器；现有单器件模板不能表示输入级、增益及输出级行为。'
  if (/\blow[-\s]+dropout\s+(?:linear\s+)?regulators?\b|\bLDO\b.{0,24}\bregulators?\b|低压差.{0,12}稳压/i.test(text))
    return '这是低压差稳压器（LDO）；现有单器件模板不能表示稳压反馈和压差特性。'
  if(/\bIGBT\b|insulated[- ]gate\s+bipolar/i.test(identity))return '这是 IGBT；不能沿用 MOS 或 BJT 单管方程，需同类厂商模型和参数映射。'
  if(/\b(?:SCR|TRIAC)\b|silicon.controlled\s+rectifier|\bthyristor\b/i.test(identity))return '这是可控硅或双向晶闸管；需要对应触发、保持电流和端序的厂商模型。'
  if(/\b(?:opto[- ]?coupler|photo[- ]?coupler|photo[- ]?transistor|opto[- ]?isolator)\b/i.test(identity))return '这是光耦或光敏器件；不能把内部晶体管作为整件模型，需光电转换与端序映射。'
  if(/\bbridge\s+rectifier\b|\b(?:dual\s+)?complementary\s+(?:transistors?|pairs?)\b|\bdual\s+(?:NPN|PNP|MOSFET|transistors?)\b/i.test(identity))return '这是整流桥或多器件结构；不能作为单二极管或单管模型，需完整厂商子电路和端序。'
  if(/\bgate\s+drivers?\b|\b(?:buck|boost|switching)\b.{0,35}\b(?:controllers?|converters?)\b|\b(?:logic\s+gates?|flip[- ]?flops?|microcontrollers?|digital\s+isolators?)\b/i.test(identity))return '这是驱动、开关控制或数字逻辑器件；不能用内部 MOS/二极管代表完整功能，需同类厂商子电路。'
  // Application examples on a discrete sheet do not identify an IC family.
  const front=identity
  if(/\b(?:precision|dual|quad|rail.to.rail|low[- ]power)\s+comparators?\b/i.test(front))return '这是比较器；内部二极管或晶体管不能代表完整功能，需要同类厂商子电路和参数映射。'
  if (!/\b(?:diode|NPN|PNP|JFET)\b|\b[NP][- ]channel\s+(?:power\s+)?MOSFET\b/i.test(front)
    && /\b(?:comparators?|(?:switching|linear|voltage)\s+regulators?|voltage\s+supervisors?|analog\s+switch(?:es)?|DC[- ]DC\s+converters?|analog.to.digital\s+converters?|digital.to.analog\s+converters?)\b/i.test(front))
    return '这是比较器、稳压器或其他集成电路；需要同类厂商子电路和已验证参数映射，不能用二极管或单管模型代替其功能。'
}
const number = '[+−-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+−-]?\\d+)?'
const unit = '(?:[munpµμk]?A/V(?:\\^?2|²)|[munpµμk]?F/m|[munpµμk]?A|[munpµμk]?F|[muk]?V|[munpµμk]?s|[muk]?(?:Ω|ohms?))'
function clean(text: string) { return text.replace(/[−–]/g, '-').replace(/[µμ]/g, 'u').replace(/\s+/g, ' ').trim() }
function spiceValue(raw: string) { return clean(raw).replace(/\s/g, '').replace(/(?:A\/V(?:\^?2|²)|F\/m|ohms?|[VAFsΩ])$/i, '') }
function testCondition(text: string, symbol: string) {
  return text.match(new RegExp(`\\b${symbol}\\s*=\\s*(${number})\\s*([munpµμk]?[AV])`, 'i'))
}
interface RowValue { value: string; basis: string; unit?:string }
function rowValue(line: string, header: string, expectedUnit?: string): RowValue | undefined {
  // Conditions (e.g. ID=250uA) precede the value columns. Only parse the final value group.
  const valueToken=`${number}(?:meg|[tgkmunpf])?`
  const suffix = line.match(new RegExp(`((?:${valueToken}|[-–—])(?:[ \\t]+(?:${valueToken}|[-–—]))*)[ \\t]*(${unit})?\\s*$`, 'i'))
  if (!suffix) return undefined
  const tokens = suffix[1].trim().split(/\s+/), units = suffix[2] ?? ''
  if (expectedUnit && (!units || !new RegExp(`${expectedUnit}$`, 'i').test(units))) return undefined
  const columns = [...header.matchAll(/\b(min(?:imum)?|typ(?:ical)?|max(?:imum)?)\.?\b/gi)].map(match => match[1].slice(0, 3).toLowerCase())
  const typ = columns.indexOf('typ')
  if (columns.length > 1 && tokens.length === columns.length) {
    const index = typ >= 0 && !/^[-–—]$/.test(tokens[typ]) ? typ : tokens.findIndex(value => !/^[-–—]$/.test(value))
    if (index < 0) return undefined
    return { value: spiceValue(tokens[index] + units),unit:units, basis: columns[index] === 'typ' ? '典型值' : columns[index] === 'min' ? '最小值（不是典型值）' : '最大值（不是典型值）' }
  }
  if (tokens.length !== 1 || /^[-–—]$/.test(tokens[0])) return undefined
  return { value: spiceValue(tokens[0] + units),unit:units, basis: /\btyp(?:ical)?\b|典型/i.test(line) ? '典型值' : '原文单值（需核对 Min / Typ / Max）' }
}
const explicitKeys:Partial<Record<ImportedModelType,string[]>>={
  D:['IS','RS','N','TT','VJ','M','BV','IBV','CJO','CJ0'],
  NPN:['IS','BF','NF','VAF','CJE','CJC','TF'],PNP:['IS','BF','NF','VAF','CJE','CJC','TF'],
  NMOS:['VTO','VTH0','KP','LAMBDA','CGSO','CGDO','CGS','CGDMIN','CGDMAX'],PMOS:['VTO','VTH0','KP','LAMBDA','CGSO','CGDO','CGS','CGDMIN','CGDMAX'],
  NJF:['VTO','BETA','CGS','CGD','IS'],PJF:['VTO','BETA','CGS','CGD','IS'],
}
const explicitUnits:Record<string,string>={IS:'A',IBV:'A',RS:'(?:Ω|ohms?)',BV:'V',VJ:'V',VAF:'V',VTO:'V',TT:'s',TF:'s',CJO:'F',CJE:'F',CJC:'F',CGS:'F',CGD:'F',CGDMIN:'F',CGDMAX:'F',CGSO:'F/m',CGDO:'F/m',KP:'A/V(?:\\^?2|²)',BETA:'A/V(?:\\^?2|²)'}

/** Equal numeric rows can share their evidence; conflicting typical rows must
 * not silently pick an arbitrary operating point as a model coefficient. */
export function selectAutomaticDatasheetParameters(extracted:readonly DatasheetParameter[],type:ImportedModelType) {
  const groups=new Map<string,DatasheetParameter[]>(),conflicts:string[]=[]
  for(const item of extracted){
    if(!item.key||!item.value||item.basis!=='典型值'&&!(item.key==='IBV'&&item.basis==='同一行的测试条件'))continue
    const value=spiceParameterNumber(item.value)
    if(value===undefined)continue
    if(item.key==='TNOM'?(value< -50||value>150):item.key==='VTO'?(['PMOS','NJF','PJF'].includes(type)?value>=0:value<=0):value<=0)continue
    const group=groups.get(item.key)??[];group.push(item);groups.set(item.key,group)
  }
  const accepted=new Map<string,DatasheetParameter>()
  for(const [key,items] of groups){
    if(items.some(item=>!equivalentModelParameterValues(item.value,items[0].value))){
      conflicts.push(`${key} 存在不同典型值或工作条件，须选择工作区或拟合曲线，未取第一行：${items.map(item=>item.evidence).join('；')}`);continue
    }
    accepted.set(key,items.length===1?items[0]:{...items[0],evidence:items.map(item=>item.evidence).join('；'),note:`${items[0].note} ${items.length} 行数值一致，条件与引用均保留。`})
  }
  if(!accepted.has('BV'))accepted.delete('IBV')
  if(!accepted.has('IBV'))accepted.delete('BV')
  return {parameters:[...accepted.values()],conflicts}
}

export function inferDatasheetType(document: DatasheetText): ImportedModelType | undefined {
  if (unsupportedDatasheetReason(document)) return undefined
  const text = document.pages.slice(0, 3).map(page => page.text).join('\n')
  if(/\bJFET\b|junction field.effect|结型场效应/i.test(text))return /p[- ]channel|P\s*沟道/i.test(text)?'PJF':/n[- ]channel|N\s*沟道/i.test(text)?'NJF':undefined
  if (/p[- ]channel|P\s*沟道/i.test(text)) return 'PMOS'
  if (/n[- ]channel|N\s*沟道/i.test(text)) return 'NMOS'
  if (/\bPNP\b/i.test(text)) return 'PNP'
  if (/\bNPN\b/i.test(text)) return 'NPN'
  if (/\bdiode\b|二极管/i.test(text)) return 'D'
}

/** Conservative suggestions: the user must review values and conditions before generating. */
export function extractDatasheetParameters(document: DatasheetText, type: ImportedModelType): DatasheetParameter[] {
  const parameters: DatasheetParameter[] = []
  const add = (page: number, index: number, label: string, line: string, value: RowValue | undefined, key: string | undefined, note: string) => {
    parameters.push({ id: `${page}-${index}-${key ?? label}`, page, label, key: value ? key : undefined, value: value?.value ?? '', evidence: `第 ${page} 页：${clean(line)}`,quote:clean(line),conditions:line.match(/\b(?:I\s*[A-Z]{1,3}|V\s*[A-Z]{1,3}|V\s*\([^)]{1,5}\)|T\s*[AJ])\s*=\s*[+−-]?(?:\d+(?:\.\d*)?|\.\d+)\s*[munpµμk]?(?:A|V|K|°\s*C)/gi)?.join('；'), note: value ? note : `${note} 未能可靠确定数值列，请对照原文手动填写。`, basis: value?.basis ?? '待核对原文' })
  }
  for (const page of document.pages) {
    let header = '',spiceTable=false,ratings=false
    const lines = page.text.split(/\r?\n/)
    for (let index = 0; index < lines.length && parameters.length < 60; index++) {
      const line = clean(lines[index]); if (!line || hasUnreadableDatasheetText(line)) continue
      if (/\bmin(?:imum)?\b.*\b(?:typ(?:ical)?|max(?:imum)?)\b|\btyp(?:ical)?\b.*\bmax(?:imum)?\b/i.test(line)) header = line
      if (/^(absolute maximum|maximum ratings|绝对最大)/i.test(line)){header='';spiceTable=false;ratings=true;continue}
      if (/electrical characteristics|SPICE.*(?:model|parameter)|电气特性/i.test(line)){ratings=false;spiceTable=/SPICE/i.test(line)}
      const declared=line.match(/^(?:SPICE\s+(?:model\s+)?(?:parameter\s+)?)?([a-z][a-z0-9]*)\b/i)?.[1].toUpperCase()
      const explicit=declared&&(spiceTable||/^SPICE\s+/i.test(line))&&explicitKeys[type]?.includes(declared)
      if(explicit&&!ratings){
        const key=declared==='CJ0'?'CJO':declared==='VTH0'?'VTO':declared
        const value=rowValue(line,header),dimension=explicitUnits[key]
        const valid=!value?.unit||dimension&&new RegExp(`${dimension}$`,'i').test(value.unit)
        add(page.number,index,`明确 SPICE 参数 ${key}`,line,valid?value:undefined,key,'规格书明确标为 SPICE 模型系数且单位符合定义；保留方程族，不从 gm 或额定值猜测。')
      } else if (ratings)continue
      else if (type === 'D' && /breakdown voltage|V\s*\(?BR\)?|击穿电压/i.test(line) && !/V\s*\(?BR\)?\s*(?:CEO|CBO|EBO|DSS)/i.test(line)) {
        const current = testCondition(line, 'I\s*R'), value = rowValue(line, header, 'V')
        add(page.number, index, '反向击穿电压', line, value, current ? 'BV' : undefined, current ? 'BV 与同一行的 IBV 成对使用；最小/最大值只能做初始近似。' : '缺少反向击穿测试电流 IR，请补全条件后手动填写 BV / IBV。')
        if (current && value) add(page.number, index, '击穿测试电流', line, { value: spiceValue(current[1] + current[2]), basis: '同一行的测试条件' }, 'IBV', '必须与此行 BV 成对确认。')
      } else if (type === 'D' && /(?:junction|diode) capacitance|\bC[JTD]O?\b|结电容/i.test(line)) {
        const bias = testCondition(line, 'V\s*R'), zero = bias && Number(bias[1]) === 0
        add(page.number, index, '结电容', line, rowValue(line, header, 'F'), zero ? 'CJO' : undefined, zero ? '明确 VR=0 的结电容，可作 CJO 初值。' : '非零或未知反偏的电容不能直接作为 CJO。')
      } else if(type==='D'&&/forward\s+voltage|正向压降|\bVF\b/i.test(line)&&!/maximum|rating|额定/i.test(line)){
        const current=testCondition(line,'I\\s*F'),temperature=line.match(new RegExp(`\\bT\\s*J\\s*=\\s*(${number})\\s*(?:°\\s*C|deg\\s*C|C)\\b`,'i')),value=rowValue(line,header,'V')
        add(page.number,index,'二极管正向 VF/IF 曲线点',line,value,undefined,'单个 VF/IF 点不能独立决定 IS/N/RS；至少三点同明确温度的典型值才可静态拟合。')
        const voltage=value?spiceParameterNumber(value.value):undefined,currentA=current?spiceParameterNumber(spiceValue(current[1]+current[2])):undefined
        if(value?.basis==='典型值'&&voltage!==undefined&&currentA!==undefined&&temperature)parameters.at(-1)!.curvePoint={currentA,voltageV:voltage,temperatureC:Number(clean(temperature[1])),page:page.number,evidence:parameters.at(-1)!.evidence,quote:parameters.at(-1)!.quote}
      } else if(type==='D'&&/ideality\s+factor|emission\s+coefficient|理想因子/i.test(line)){
        add(page.number,index,'二极管理想因子',line,rowValue(line,header),'N','明确二极管理想因子对应 N；不是任意电流下的正向压降。')
      } else if(type==='D'&&/\b(?:carrier\s+)?transit\s+time\b|载流子渡越时间/i.test(line)&&!/reverse\s+recovery|trr|反向恢复/i.test(line)){
        add(page.number,index,'二极管载流子渡越时间',line,rowValue(line,header,'s'),'TT','明确载流子渡越时间；反向恢复时间 trr 不等于 TT。')
      } else if((type==='NPN'||type==='PNP')&&/\b(?:forward\s+)?Early\s+voltage\b|厄利电压/i.test(line)){
        add(page.number,index,'正向 Early 电压',line,rowValue(line,header,'V'),/reverse|反向/i.test(line)?undefined:'VAF','仅正向 Early 电压对应 VAF；反向 Early 电压和击穿额定值不能替代。')
      } else if((type==='NPN'||type==='PNP')&&/base[- ]emitter.*capacitance|B[-–]E.*capacitance|\bCJE\b|基极.*发射极.*电容/i.test(line)){
        const bias=testCondition(line,'V\\s*BE')
        add(page.number,index,'零偏 B–E 结电容',line,rowValue(line,header,'F'),bias&&Number(bias[1])===0?'CJE':undefined,'CJE 仅由明确 VBE=0 的 B–E 结电容映射；输入等效电容不是直接系数。')
      } else if((type==='NPN'||type==='PNP')&&/base[- ]collector.*capacitance|B[-–]C.*capacitance|\bCJC\b|基极.*集电极.*电容/i.test(line)){
        const bias=testCondition(line,'V\\s*BC')
        add(page.number,index,'零偏 B–C 结电容',line,rowValue(line,header,'F'),bias&&Number(bias[1])===0?'CJC':undefined,'CJC 仅由明确 VBC=0 的 B–C 结电容映射；非零偏电容不能直接代入。')
      } else if((type==='NJF'||type==='PJF')&&/gate[- ]source.*capacitance|\bCGS\b|栅源.*电容/i.test(line)){
        const bias=testCondition(line,'V\\s*GS')
        add(page.number,index,'JFET 零偏 G–S 结电容',line,rowValue(line,header,'F'),bias&&Number(bias[1])===0?'CGS':undefined,'仅明确 VGS=0 的 G–S 结电容可作为 CGS；保留测试条件。')
      } else if((type==='NJF'||type==='PJF')&&/gate[- ]drain.*capacitance|\bCGD\b|栅漏.*电容/i.test(line)){
        const bias=testCondition(line,'V\\s*GD')
        add(page.number,index,'JFET 零偏 G–D 结电容',line,rowValue(line,header,'F'),bias&&Number(bias[1])===0?'CGD':undefined,'仅明确 VGD=0 的 G–D 结电容可作为 CGD；保留测试条件。')
      } else if ((type === 'NPN' || type === 'PNP') && /h\s*FE\b|dc current gain|直流电流增益/i.test(line)) {
        const conditions = testCondition(line, 'I\s*C') && testCondition(line, 'V\s*CE')
        add(page.number, index, '直流电流增益 hFE', line, rowValue(line, header), conditions ? 'BF' : undefined, conditions ? 'hFE 仅作 BF 的初始近似，必须检查 IC / VCE；大电流增益不能替代完整拟合。' : '缺少 IC 或 VCE 测试条件，请手动补全；不能直接把范围写成 BF。')
      } else if ((type === 'NMOS' || type === 'PMOS') && /V\s*GS\s*\(?th\)?|gate.*threshold|栅.*阈值/i.test(line)) {
        const current = testCondition(line, 'I\s*D')
        add(page.number, index, '栅源阈值 VGS(th)', line, rowValue(line, header, 'V'), current ? 'VTO' : undefined, `${current ? 'VGS(th) 仅作 VTO 初始近似，保留 ID 条件。' : '缺少 ID 测试条件，需补全后手动填写。'}${type === 'PMOS' ? 'P 沟道应填写负值；不会自动翻转原文极性。' : ''}`)
      } else if ((type==='NJF'||type==='PJF')&&/V\s*GS\s*\(?off\)?|gate.*cutoff|栅.*截止/i.test(line)) {
        add(page.number,index,'栅源截止电压 VGS(off)',line,rowValue(line,header,'V'),undefined,'截止电压依赖 ID / VDS 测试条件，仅保留作 VTO 拟合参考；请核对曲线后手动填写。')
      } else if (/R\s*DS\s*\(?on\)?|on.state resistance|导通电阻|reverse recovery|反向恢复|\bCiss\b|\bCoss\b|\bCrss\b|V\s*RRM\b|maximum.*voltage|transition frequency|\bfT\b|transconductance|\bgfs\b|gate[- ](?:source|drain).*capacitance/i.test(line)) {
        add(page.number, index, '其他关键规格', line, rowValue(line, header), undefined, '此规格不直接映射到单一 SPICE 参数，保留作核对依据。')
      }
    }
  }
  if(type==='D'){
    const points=parameters.flatMap(item=>item.curvePoint?[item.curvePoint]:[])
    if(points.length){const fitted=fitDiodeForwardPoints(points);parameters.push(...fitted.parameters);if(fitted.reason)parameters.push({id:'diode-fit-blocked',page:points[0].page,label:'二极管正向拟合未完成',value:'',evidence:points.map(point=>point.evidence).join('；'),note:fitted.reason,basis:'待核对原文'})}
  }
  return parameters
}
