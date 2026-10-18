import { useState } from 'react'
import type { Project } from '../core/circuit'
import { linearSweepValues, maxSweepRuns, simulationTemperature, sweepTargets } from '../core/simulation-experiment'

export default function SimulationExperimentSettings({project,onChange,embedded=false}:{project:Project;onChange:(project:Project)=>void;embedded?:boolean}) {
  const targets=sweepTargets(project)
  const [temperature,setTemperature]=useState(String(simulationTemperature(project)))
  const [list,setList]=useState(project.sweep?.values.join(', ')??'')
  const [start,setStart]=useState(''),[stop,setStop]=useState(''),[count,setCount]=useState(3),[error,setError]=useState('')
  const [page,setPage]=useState<'settings'|'list'|'generator'>('settings')
  const sweep=project.sweep
  function enable(enabled:boolean){
    const target=sweep?.target??'temperature',values=sweep?.values??['-40','27','85']
    setList(values.join(', '));onChange({...project,sweep:enabled?{target,values}:undefined});setError('');if(!enabled)setPage('settings')
  }
  function changeTarget(target:string){
    const value=targets.find(item=>item.target===target)?.value??''
    setList(value);setStart(value);setStop('');setError('');onChange({...project,sweep:{target,values:[value]}})
  }
  function generate(){try{const values=linearSweepValues(project,sweep!.target,start,stop,count);setList(values.join(', '));onChange({...project,sweep:{target:sweep!.target,values}});setError('')}catch(reason){setError((reason as Error).message)}}
  return <section className="simulation-analysis-fields"><h3>温度与参数扫描</h3>
    {embedded && sweep && <nav className="simulation-inline-subpages" aria-label="参数扫描页面"><button type="button" aria-pressed={page === 'settings'} onClick={() => setPage('settings')}>温度</button><button type="button" aria-pressed={page === 'list'} onClick={() => setPage('list')}>扫描列表</button><button type="button" aria-pressed={page === 'generator'} onClick={() => setPage('generator')}>生成列表</button></nav>}
    <div hidden={embedded && page !== 'settings'}>
    <label className="field"><span>仿真温度 (°C)</span><input aria-label="仿真温度 (°C)" inputMode="decimal" value={temperature} onChange={event=>{const value=event.target.value;setTemperature(value);onChange({...project,temperature:value.trim()?Number(value):NaN})}}/></label>
    <p className="field-hint">默认 27°C。影响工作点和器件噪声；温度特性取决于模型，不会修改模型的标称温度 TNOM。</p>
    <label className="simulation-sweep-toggle"><input type="checkbox" aria-label="启用参数扫描" checked={!!sweep} onChange={event=>enable(event.target.checked)}/><span>启用参数扫描</span></label>
    </div>
    <div hidden={embedded && page !== 'list'}>
    {sweep&&<>
      <label className="field"><span>扫描对象</span><select aria-label="扫描对象" value={sweep.target} onChange={event=>changeTarget(event.target.value)}>{!targets.some(item=>item.target===sweep.target)&&<option value={sweep.target}>{sweep.target} · 已不存在</option>}{targets.map(item=><option key={item.target} value={item.target}>{item.label}</option>)}</select></label>
      <label className="field"><span>扫描数值列表</span><input aria-label="扫描数值列表" value={list} placeholder={sweep.target==='temperature'?'-40, 27, 85':'1k, 2k, 5k'} onChange={event=>{const value=event.target.value;setList(value);onChange({...project,sweep:{...sweep,values:value.split(/[,，;；\s]+/).filter(Boolean)}})}}/></label>
      <p className="field-hint">以逗号或空格分隔，最多 {maxSweepRuns} 次仿真。R/C/L 可带单位；电压和电流源只扫描 DC 数值，保留其波形和 AC 设置。扫描温度时使用列表中的温度。</p>
    </>}
    </div>
    {sweep && <details className={embedded ? 'simulation-inline-generator' : undefined} open={embedded ? page === 'generator' : undefined} hidden={embedded && page !== 'generator'}><summary>生成线性扫描列表</summary><div className="field-pair"><label className="field"><span>扫描起始值</span><input aria-label="参数扫描起始值" value={start} onChange={event=>setStart(event.target.value)}/></label><label className="field"><span>扫描结束值</span><input aria-label="参数扫描结束值" value={stop} onChange={event=>setStop(event.target.value)}/></label></div><label className="field"><span>扫描点数</span><input type="number" aria-label="参数扫描点数" min={2} max={maxSweepRuns} value={count} onChange={event=>setCount(Number(event.target.value))}/></label><button type="button" onClick={generate}>生成数值列表</button></details>}
    {sweep && error&&<p className="simulation-settings-error" role="alert">{error}</p>}
  </section>
}
