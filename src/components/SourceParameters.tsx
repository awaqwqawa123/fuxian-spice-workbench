import type { Device } from '../core/drawing'
import type { Project } from '../core/circuit'
import { editableSource, sourceDefaults, sourceWaveforms, sourceWaveformNames, type SourceWaveform } from '../core/sources'
import { sourceSpice } from '../core/spice-elements'
import { sourceExpressionExamples } from '../core/source-expression'
import SourceWaveformPreview from './SourceWaveformPreview'

/** Each voltage/current source keeps independent DC, AC and transient settings. */
export default function SourceParameters({device,project,onChange}:{device:Device;project:Project;onChange:(device:Device)=>void}) {
  if(device.kind!=='V'&&device.kind!=='I')return null
  let source:Device
  try{source=editableSource(device,project)}catch{source={...device,params:sourceDefaults(device.kind)}}
  const wave=source.params!.waveform as SourceWaveform,defaults=sourceDefaults(device.kind,wave)
  const unit=device.kind==='V'?'V':'A'
  const change=(key:string,value:string)=>onChange({...source,params:{...source.params,[key]:value}})
  const field=(key:string,label:string,hint?:string)=><label key={key}>{label}<input aria-label={`${device.id} ${label}`} value={source.params?.[key]??defaults[key]} onChange={e=>change(key,e.target.value)} spellCheck={false}/>{hint&&<small>{hint}</small>}</label>
  let code='',error=''
  try{code=sourceSpice(project,device)}catch(cause){error=(cause as Error).message}
  return <section className="device-parameters source-parameters" aria-label={`${device.id} 激励参数`}>
    <label>瞬态波形<select aria-label={`${device.id} 瞬态波形`} value={wave} onChange={event=>onChange({...source,params:{...sourceDefaults(device.kind as 'V'|'I',event.target.value as SourceWaveform),acAmplitude:source.params!.acAmplitude??defaults.acAmplitude,acPhase:source.params!.acPhase??'0'}})}>{sourceWaveforms.map(w=><option key={w} value={w}>{sourceWaveformNames[w]}</option>)}</select></label>
    <label>直流工作点 ({unit})<input aria-label={`${device.id} 直流工作点`} value={source.value} onChange={event=>onChange({...source,value:event.target.value})} spellCheck={false}/></label>
    <div className="source-field-pair">{field('acAmplitude',`AC 幅度 (${unit})`)}{field('acPhase','AC 相位 (°)')}</div>
    {wave==='sine'&&<>
      <div className="source-field-pair">{field('offset',`偏置 (${unit})`)}{field('amplitude',`峰值幅度 (${unit})`)}</div>
      {field('frequency','频率 (Hz)')}
      <div className="source-field-pair">{field('delay','延时 (s)')}{field('phase','初相位 (°)')}</div>
    </>}
    {wave==='pulse'&&<>
      <div className="source-field-pair">{field('low',`低电平 (${unit})`)}{field('high',`高电平 (${unit})`)}</div>
      {field('delay','延时 (s)')}
      <div className="source-field-pair">{field('rise','上升时间 (s)')}{field('fall','下降时间 (s)')}</div>
      <div className="source-field-pair">{field('width','高电平宽度 (s)')}{field('period','周期 (s)')}</div>
      <small>三角波：使用很短的高电平宽度（例如 1ps），其余周期分给上升与下降段。不能填 0：ngspice 会把它解释为默认宽度。</small>
    </>}
    {wave==='expression'&&<><label>波形模板<select aria-label={`${device.id} 波形模板`} value="" onChange={event=>{const example=sourceExpressionExamples.find(item=>item.id===event.target.value);if(example)change('expression',`${device.kind==='I'?'1m*(':''}${example.expression}${device.kind==='I'?')':''}`)}}><option value="">选择函数示例…</option>{sourceExpressionExamples.map(example=><option key={example.id} value={example.id}>{example.label}</option>)}</select></label><label>波形代码 ({unit})<textarea aria-label={`${device.id} 波形代码`} value={source.params!.expression??defaults.expression} onChange={event=>change('expression',event.target.value)} spellCheck={false} rows={4}/><small>输入一行数学表达式，time 单位为秒，结果单位为 {unit}。支持 sin/cos/exp/ln/sqrt/abs/tanh/min/max/floor/ceil、+ − * / ^ 和条件 ? :，数值可用 1k、1m。</small><small>例如：sin(2*pi*1k*time)；time &lt; 1m ? 0 : exp(-(time-1m)/2m)。DC / AC 仿真仍使用上方独立设置。</small></label><details className="source-expression-help"><summary>波形函数与单位</summary><small>step(x)：x ≥ 0 时为 1；ramp(x)：max(0,x)。triangle(c)、square(c)、saw(c) 的 c 为周期相位，例如 1k*time，输出 −1～1。</small><small>pulse(time,宽度,周期) 输出 0／1；window(time,开始,结束) 在指定时间窗输出 1。时间边界为常数、单位为秒。电流示例乘 1m 得到 mA，电压示例结果单位 V。</small><small>理想阶跃的跳变不会考虑带宽、上升时间与负载。需要有限沿时使用 PULSE 或 PWL。</small></details></>}
    {wave==='pwl'&&<label>时间 / 数值点<textarea aria-label={`${device.id} PWL 时间与数值`} value={source.params!.points??defaults.points} onChange={event=>change('points',event.target.value)} spellCheck={false} rows={5}/><small>每行一对：0s 0{unit}。从 0s 开始，时间严格递增；末点之后保持末值，不自动循环。</small></label>}
    <SourceWaveformPreview key={device.id} device={device} project={project}/>
    {error?<p role="alert" className="parameter-error">{error}</p>:<div className="source-spice-preview"><span>当前分析使用的 SPICE</span><code>{code}</code></div>}
    <p className="model-limit-note">DC / 工作点使用直流值；AC 使用幅度和相位；瞬态使用所选波形。{device.kind==='I'?'电流正方向为引脚 1 → 2；工程仍需一个接地电压源作为输入参考。':'各电压源独立设置；输入参考源用于增益与噪声参考；DC 扫描源可在仿真配置中独立选择。'}</p>
  </section>
}
