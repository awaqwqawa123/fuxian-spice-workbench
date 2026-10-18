import { dcSweep, formatSI, parseQuantity, type Project, type Quantity } from './circuit'
import { deviceParameterDefinitions, deviceParameterValues, deviceModelNotes } from './device-parameters'
import { modelFor, models } from './devices'
import { compileDrawing } from './drawing'
import { editableProject } from './editor'
import { spiceCodePreview } from './spice-code'
import { opAmpParameters, opAmpModelFor } from './opamp-models'
import { isConfiguredSource, sourceValues, sourceWaveformNames } from './sources'

export interface ModelParameterRow { key:string; label:string; value:string; unit:string; note:string; source:string }
export interface ModelParameterSummary { title:string; rows:ModelParameterRow[]; note:string; description?:string; forwardReference?:{temperature:number;points:{current:number;voltage:number}[]} }
type Definition = [label:string, unit:string, note:string]
const common:Record<string,Definition> = {
  IS:['饱和电流','A','PN 结电流方程参数，不是额定工作电流'], RS:['串联电阻','Ω','模型内部串联电阻'],
  N:['发射系数','','PN 结指数方程系数'], BV:['反向击穿电压','V','模型击穿拐点，不等同于器件绝对最大额定值'], IBV:['击穿参考电流','A','定义 BV 时采用的反向电流'],
  CJO:['零偏结电容','F','结电压为零时的电容'], CJ0:['零偏结电容','F','CJO 的别名'], TT:['渡越时间','s','存储电荷模型的时间参数，不直接等于反向恢复时间'],
  VJ:['结内建电势','V','结电容随电压变化的模型参数'], M:['结梯度系数','','结电容非线性系数'], TNOM:['参数标称温度','°C','模型参数的参考温度'],
}
const bipolar:Record<string,Definition> = {
  BF:['正向电流增益','','理想最大正向增益，实际 β 随电流与偏置变化'], BR:['反向电流增益','','理想最大反向电流增益'],
  VAF:['正向 Early 电压','V','描述输出电阻与 Early 效应'], IKF:['高注入拐点电流','A','正向增益开始下降的模型参数'],
  RB:['基极电阻','Ω','零偏置基极电阻'], RC:['集电极电阻','Ω','模型内部集电极串联电阻'], RE:['发射极电阻','Ω','模型内部发射极串联电阻'],
  CJE:['BE 零偏电容','F','基极－发射极结电容'], CJC:['BC 零偏电容','F','基极－集电极结电容'], TF:['正向渡越时间','s','正向存储电荷时间常数'], TR:['反向渡越时间','s','反向存储电荷时间常数'],
}
const mos:Record<string,Definition> = {
  LEVEL:['模型级别','','ngspice MOS 方程族'], VTO:['零偏阈值电压','V','模型阈值参数，不等于数据手册全部测试条件下的 VGS(th)'], VTH0:['阈值电压','V','模型的阈值参数'],
  KP:['跨导系数','A/V²','平方律或 VDMOS 电流方程系数'], LAMBDA:['沟道长度调制','1/V','描述漏极电压对输出电流的影响'],
  RD:['漏极串联电阻','Ω','内部串联电阻，不代表整管 RDS(on)'], RG:['栅极电阻','Ω','内部栅极电阻'], RDS:['漏源漏电电阻','Ω','关断漏电通路，不是导通电阻'],
  CGS:['栅源电容','F','VDMOS 栅源电容'], CGDMIN:['最小栅漏电容','F','VDMOS 电压相关栅漏电容下限'], CGDMAX:['最大栅漏电容','F','VDMOS 电压相关栅漏电容上限'],
  CGSO:['栅源重叠电容/宽度','F/m','MOS 重叠电容单位宽度值'], CGDO:['栅漏重叠电容/宽度','F/m','MOS 重叠电容单位宽度值'], TOX:['栅氧化层厚度','m','物理模型参数'],
}
const switches:Record<string,Definition> = { RON:['导通电阻','Ω','开关闭合时的电阻'], ROFF:['关断电阻','Ω','开关断开时的电阻'], VT:['控制阈值','V','电压控制开关阈值'], VH:['迟滞半宽','V','阈值上下的迟滞宽度'] }
const jfet:Record<string,Definition>={VTO:['夹断电压','V','JFET 模型夹断参数'],BETA:['跨导系数','A/V²','电流方程系数，不能直接替代数据手册 gfs'],LAMBDA:['沟道长度调制','1/V','漏极电压对电流的影响'],RD:['漏极串联电阻','Ω','内部电阻'],CGS:['栅源电容','F','零偏结电容'],CGD:['栅漏电容','F','零偏结电容']}
const units:Partial<Record<Quantity,string>> = { resistance:'Ω',capacitance:'F',inductance:'H',voltage:'V',current:'A',frequency:'Hz',time:'s',gain:'' }

/** Read only explicit constants. Do not infer simulator defaults or treat marketing ratings as model parameters. */
export function modelCodeParameters(code:string, source='当前 .model 源码'):ModelParameterSummary {
  const logical=code.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g,m=>' '.repeat(m.length)).split(/\r?\n/).map(line=>line.replace(/^\s*\*.*$/,'').replace(/[;$].*$/,'')).join('\n').replace(/\n\s*\+/g,' ').split('\n').map(line=>line.trim())
  const line=logical.find(item=>/^\.model\s/i.test(item))
  if(!line)return{title:'模型关键参数',rows:[],note:/^\s*\.subckt\s/im.test(code)?'此文件为子电路；内部参数依赖电路实现，不能直接映射为单个器件的额定参数。当前编辑器不支持导入 .subckt。':'未发现可识别的 .model 定义。'}
  const header=line.match(/^\.model\s+(\S+)\s+(\w+)\s*(.*)$/i)
  if(!header)return{title:'模型关键参数',rows:[],note:'请继续输入完整的 .model 名称、类型和参数。'}
  const type=header[2].toUpperCase(), definitions={...common,...(type==='NPN'||type==='PNP'?bipolar:{}),...(/MOS/.test(type)?mos:{}),...(/^[NP]JF$/.test(type)?jfet:{}),...(type==='SW'?switches:{})}
  const rows:ModelParameterRow[]=[]
  for(const match of header[3].matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*([^\s(),]+)/gi)){
    const key=match[1].toUpperCase(), value=match[2]
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(value))continue
    const definition=definitions[key]
    if(definition)rows.push({key,label:definition[0],value,unit:definition[1],note:definition[2],source})
  }
  // Reference values apply only to our known simple LED equations. Imported
  // models can include high-injection, geometry or temperature behavior; do not
  // silently reduce those models to Shockley's equation.
  const builtinLed=models.find(model=>/^D_LED_/.test(model.id)&&model.spice.replace(/\s/g,'').toUpperCase()===line.replace(/\s/g,'').toUpperCase())
  let forwardReference:ModelParameterSummary['forwardReference']
  if(builtinLed){
    const parameter=(key:string)=>parseQuantity(rows.find(row=>row.key===key)!.value,'gain')
    const saturation=parameter('IS'),emission=parameter('N'),resistance=parameter('RS'),temperature=27
    const thermalVoltage=8.617333262145e-5*(temperature+273.15)
    forwardReference={temperature,points:[.02,.05].map(current=>({current,voltage:emission*thermalVoltage*Math.log1p(current/saturation)+current*resistance}))}
  }
  return{title:`${header[1]} · ${type} 关键参数`,rows,...(forwardReference?{forwardReference}:{}),note:'仅列出源码显式定义的关键参数；省略项由对应 ngspice 模型级别决定，不推测默认值。m = 毫，meg = 兆。'+(type==='D'?' 正向压降 VF 随电流和温度变化，由模型求解，不是独立的固定电压参数。':'')}
}

export function projectModelParameters(project:Project,deviceId?:string,modelId?:string):ModelParameterSummary|null {
  if(modelId){
    const model=project.models?.find(item=>item.id===modelId)
    if(!model)throw new Error('模型已不存在，请重新选择。')
    return {...modelCodeParameters(model.spice,model.source.label),description:model.detail}
  }
  if(!deviceId)return null
  const p=editableProject(project), drawing=p.drawing!, part=drawing.devices.find(item=>item.id===deviceId)
  if(!part)throw new Error('器件已不存在，请重新选择。')
  const model=modelFor(part.kind,part.value,p.models)
  if(model){
    const summary=modelCodeParameters(model.spice,'source' in model?model.source.label:'内置通用教学模型')
    if('source' in model)summary.description=model.detail
    if(part.kind==='M'&&!('technology' in model&&model.technology==='VDMOS')){
      // Geometry is emitted by deviceSpice; read it from the actual device statement.
      const statement=spiceCodePreview(p,part.id).code.split('\n')[0]
      for(const key of ['W','L']){
        const value=statement.match(new RegExp(`\\b${key}=([^\\s]+)`,'i'))?.[1]
        if(value)summary.rows.push({key,label:key==='W'?'沟道宽度':'沟道长度',value,unit:'m',note:'当前器件实例采用的几何尺寸',source:'实际网表器件语句'})
      }
    }
    return summary
  }
  const rows:ModelParameterRow[]=[]
  const add=(key:string,label:string,raw:string,quantity:Quantity,note:string,source='当前器件参数')=>rows.push({key,label,value:formatSI(parseQuantity(raw,quantity),units[quantity]??'',6),unit:'',note,source})
  const primary=part.kind==='V'&&part.id===compileDrawing(drawing).sourceId
  const sweepNote=primary&&p.analysis==='dc'?` 当前分析为 DC 扫描：${dcSweep(p).start} → ${dcSweep(p).stop}，步进 ${dcSweep(p).step}；仿真时扫描指令覆盖此源的直流设定值，扫描范围不是器件的固定电压。`:''
  if(isConfiguredSource(part)){
    const source=sourceValues(part),quantity=part.kind==='V'?'voltage':'current',unit=units[quantity]!
    const numeric=(key:string,label:string,value:number,quantity:Quantity,note:string)=>add(key,label,String(value),quantity,note)
    const expression=p.analysis==='tran'&&source.waveform==='expression'
    if(!expression)numeric('DC',part.kind==='V'?'直流电压':'直流电流',source.dc,quantity,'器件设置的直流工作点值')
    if(p.analysis==='ac'||p.analysis==='noise'){
      numeric('AC','AC 幅度',source.acAmplitude,quantity,'当前小信号分析使用的激励幅度')
      rows.push({key:'AC_PHASE',label:'AC 相位',value:String(source.acPhase),unit:'°',note:'当前小信号分析使用的相位',source:'当前器件参数'})
    }
    if(p.analysis==='tran'){
      rows.push({key:'WAVEFORM',label:'瞬态波形',value:sourceWaveformNames[source.waveform],unit:'',note:'当前瞬态分析使用的器件波形',source:'当前器件参数'})
      const definitions:[string,string,Quantity][] = source.waveform==='sine'
        ? [['offset','直流偏置',quantity],['amplitude','正弦峰值',quantity],['frequency','频率','frequency'],['delay','延时','time']]
        : source.waveform==='pulse'? [['low','低电平',quantity],['high','高电平',quantity],['delay','延时','time'],['rise','上升时间','time'],['fall','下降时间','time'],['width','高电平宽度','time'],['period','周期','time']]:[]
      for(const [key,label,kind] of definitions)numeric(key,label,source.values[key],kind,'当前瞬态波形参数')
      if(source.waveform==='sine')rows.push({key:'PHASE',label:'初相位',value:String(source.values.phase),unit:'°',note:'正弦波初相位',source:'当前器件参数'})
      if(source.points)rows.push({key:'POINTS',label:'时间 / 数值点',value:source.points.map(([time,value])=>`${formatSI(time,'s',6)} / ${formatSI(value,unit,6)}`).join('；'),unit:'',note:'末点之后保持末值',source:'当前器件参数'})
      if(expression)rows.push({key:'EXPRESSION',label:'波形代码',value:source.expression!,unit:'',note:`time 单位为秒，结果单位为 ${unit}`,source:'当前器件参数'})
    }
    return{title:`${part.id} · 电气参数`,rows,note:'参数来自当前器件自身的电源设置，与当前分析使用的 SPICE 代码一致；修改后需重新仿真。'+sweepNote}
  }
  if(part.kind==='GND')return{title:`${part.id} · 参考地`,rows:[],note:'连接的网络对应 SPICE 节点 0；接地符号没有电气模型参数。'}
  if(part.kind==='R')add('R','电阻',part.value,'resistance','理想线性电阻；未添加温度与寄生参数')
  if(part.kind==='C')add('C','电容量',part.value,'capacitance','理想电容；未添加 ESR 与漏电模型')
  if(part.kind==='L')add('L','电感量',part.value,'inductance','理想线性电感；未添加绕组电阻或饱和模型')
  if(part.kind==='I')add('DC','直流电流',part.value,'current','正方向为引脚 1 → 2')
  if(part.kind==='V'&&!primary)add('DC','直流电压',part.value,'voltage','引脚 1 相对于引脚 2 的电压')
  if(part.kind==='OP')add('GAIN','开环增益',part.value,'gain','有限增益理想受控源；未包含供电轨、饱和、带宽')
  if(part.kind==='OPA'||part.kind==='CMP'){
    const preset=opAmpParameters(part.kind,part.value)
    if(preset){
      rows.push({key:'PART',label:'型号',value:part.value,unit:'',note:'规格书参考的行为近似预设；不等同于厂商宏模型',source:opAmpModelFor(part.kind,part.value)?.manufacturer??'内置参考'})
      rows.push({key:'GAIN',label:'开环增益',value:formatSI(preset.gain,'',6),unit:'V/V',note:'有限开环增益；典型值',source:opAmpModelFor(part.kind,part.value)?.datasheetUrl??'内置参考'})
      rows.push({key:'BANDWIDTH',label:part.kind==='OPA'?'增益带宽积':'响应带宽',value:formatSI(preset.bandwidth,'Hz',6),unit:'Hz',note:'单极点行为模型的典型频率参数',source:opAmpModelFor(part.kind,part.value)?.datasheetUrl??'内置参考'})
    }
  }
  if(primary){
    if(p.analysis==='dc')add('DC','直流电压',p.source.dc,'voltage','旧工程输入参考源的直流设定值','输入激励参数')
    else if(p.analysis==='tran'){
      add('OFFSET','直流偏置',p.source.offset,'voltage','波形基准电平','输入激励参数')
      add('AMPLITUDE',p.source.waveform==='sine'?'正弦峰值':'高低电平差',p.source.amplitude,'voltage','当前瞬态波形幅度','输入激励参数')
      add('FREQUENCY','频率',p.source.frequency,'frequency','当前瞬态周期的倒数','输入激励参数')
    }else{add('DC','直流偏置',p.source.dc,'voltage','工作点电压','输入激励参数');if(p.analysis==='ac'||p.analysis==='noise')add('AC','小信号幅度','1V','voltage','AC 分析的实际固定激励','实际网表器件语句')}
  }
  if(part.kind==='SW')rows.push({key:'STATE',label:'触点状态',value:part.value==='ON'?'闭合 ON':'断开 OFF',unit:'',note:'通过对应接触电阻参与求解',source:'当前器件参数'})
  if(part.kind==='LDO')add('VOUT','输出设定电压',part.value,'voltage','输出目标值；实际输出取决于输入余量与负载')
  if(part.kind==='XFMR')add('RATIO','匝数比 Ns/Np',part.value,'gain','次级电感 = 初级电感 × 变比²')
  const values=deviceParameterValues(part)
  for(const definition of deviceParameterDefinitions[part.kind]??[])rows.push({key:definition.key,label:definition.label,value:formatSI(values[definition.key],units[definition.quantity]??'',6),unit:'',note:definition.label,source:part.params?.[definition.key]===undefined?'器件默认值 · 已写入实际网表':'当前器件参数'})
  return{title:`${part.id} · 电气参数`,rows,note:(deviceModelNotes[part.kind]??'参数来自当前器件及实际使用的分析设置；修改后需重新仿真。')+sweepNote}
}
