import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Copy, Play, Plus, Settings2, Trash2, X } from 'lucide-react'
import { analysisDirective, dcSweep, parseProject, validateProject, type Analysis, type Project } from '../core/circuit'
import { compileDrawing, terminalKey, type Pin, type Terminal } from '../core/drawing'
import { deviceCatalog, pinsFor } from '../core/devices'
import { useWorkbenchDialog } from './AssistantWindow'
import { applySimulationProfile, createSimulationProfile, initialSimulationProfiles, updateSimulationProfile, type SimulationProfiles } from '../core/simulation-profiles'
import SimulationExperimentSettings from './SimulationExperimentSettings'
import { simulationControlDirectives } from '../core/simulation-options'

const names: Record<Analysis, string> = { ac: 'AC 频率响应', noise: '噪声分析', tran: '瞬态分析', dc: 'DC 扫描', op: '直流工作点' }
function Field({ label, value, onChange, type = 'text', hint, placeholder }: { label: string; value: string | number; onChange: (value: string) => void; type?: string; hint?: string; placeholder?: string }) {
  return <label className="field"><span>{label}</span><input aria-label={label} type={type} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} spellCheck={false}/>{hint && <small className="field-hint">{hint}</small>}</label>
}

type SettingsPage = 'profiles' | 'analysis' | 'reference' | 'experiment' | 'advanced' | 'switches'

export default function SimulationSettings({ project, profiles, newProfile=false, embedded=false, modal=!embedded, onProfilesApply, onApply, onApplyAndRun, runRequest=0, busy=false, onClose }: { project: Project; profiles?:SimulationProfiles; newProfile?:boolean; embedded?:boolean; modal?:boolean; onProfilesApply?:(profiles:SimulationProfiles)=>void; onApply: (project: Project) => void; onApplyAndRun?: (project: Project, profiles: SimulationProfiles) => void; runRequest?: number; busy?: boolean; onClose: () => void }) {
  const [initial]=useState(()=>{const initialProfiles=structuredClone(profiles??initialSimulationProfiles(project));return newProfile?createSimulationProfile(initialProfiles,structuredClone(project)):{profiles:initialProfiles,project:structuredClone(project)}})
  const [draft, setDraft] = useState(initial.project)
  const [profileDraft,setProfileDraft]=useState<SimulationProfiles>(initial.profiles)
  const selectedProfile=profileDraft.profiles.find(p=>p.id===profileDraft.activeId)!
  function selectProfile(id:string){const updated=updateSimulationProfile(profileDraft,draft),selected=updated.profiles.find(p=>p.id===id);if(!selected)return;setProfileDraft({...updated,activeId:id});setDraft(applySimulationProfile(draft,selected))}
  function addProfile(copy:boolean){const next=createSimulationProfile(profileDraft,draft,copy);setProfileDraft(next.profiles);setDraft(next.project)}
  function removeProfile(){if(profileDraft.profiles.length<2)return;const remaining=profileDraft.profiles.filter(p=>p.id!==profileDraft.activeId);setProfileDraft({...profileDraft,activeId:remaining[0].id,profiles:remaining});setDraft(applySimulationProfile(draft,remaining[0]))}
  const [snapshot] = useState(() => JSON.stringify(project))
  const panel = useRef<HTMLElement>(null)
  useWorkbenchDialog(panel, modal, onClose)
  const pageId = useId()
  const [page, setPage] = useState<SettingsPage>(newProfile ? 'profiles' : 'analysis')
  const [switchPage, setSwitchPage] = useState(0)
  const [advancedOpen,setAdvancedOpen]=useState(!!initial.project.sweep || initial.project.temperature !== undefined && initial.project.temperature !== 27)
  const drawing = draft.drawing!, topology = useMemo(() => compileDrawing(drawing), [drawing])
  const switches = drawing.devices.filter(device => device.kind === 'SW')
  const switchPages = Math.max(1, Math.ceil(switches.length / 3))
  const currentSwitchPage = Math.min(switchPage, switchPages - 1)
  const pages: { id: SettingsPage; name: string }[] = [
    ...(profiles || newProfile ? [{ id: 'profiles' as const, name: '配置' }] : []),
    { id: 'analysis', name: '分析' }, { id: 'reference', name: '参考' },
    { id: 'advanced', name: '高级' }, { id: 'experiment', name: '扫描' }, ...(switches.length ? [{ id: 'switches' as const, name: '触点' }] : []),
  ]
  const activePage = pages.some(item => item.id === page) ? page : 'analysis'
  function navigatePages(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = pages.findIndex(item => item.id === activePage)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + pages.length) % pages.length
    setPage(pages[next].id)
    event.currentTarget.querySelector<HTMLButtonElement>(`[id="${pageId}-${pages[next].id}-tab"]`)?.focus()
  }
  const pageAttributes = (id: SettingsPage) => embedded ? { hidden: activePage !== id, role: 'tabpanel', id: `${pageId}-${id}`, 'aria-labelledby': `${pageId}-${id}-tab` } : {}
  const stale = snapshot !== JSON.stringify(project)
  const dirty = JSON.stringify(draft)!==JSON.stringify(initial.project)||JSON.stringify(profileDraft)!==JSON.stringify(initial.profiles)
  let error = '', runError = '', command = '', commonCommands = ''
  try {
    parseProject(draft, { allowDraft: true })
    // Use actual per-device sources; only unfinished connection errors are deferred.
    const connectionErrors=new Set(topology.errors)
    const issues = validateProject(draft)
    error = issues.find(message=>!connectionErrors.has(message)) ?? ''
    runError = issues[0] ?? ''
    if (!error) { command = analysisDirective(draft); commonCommands = [...simulationControlDirectives(draft), ...(draft.temperature !== undefined ? [`.temp ${draft.temperature}`] : [])].filter(Boolean).join('\n') }
  } catch (reason) { error = (reason as Error).message }
  if (stale) error = '电路已变化，请重新打开仿真设置，避免覆盖新的修改。'
  function updateDrawing(change: Partial<typeof drawing>) { setDraft(old => ({ ...old, drawing: { ...old.drawing!, ...change } })) }
  if(profileDraft.profiles.some(p=>!p.name.trim()))error='请为每个配置填写名称。'
  function apply(run=false) {
    if (error || run && (busy || runError)) return
    const appliedProfiles = updateSimulationProfile(profileDraft,draft)
    if (run && onApplyAndRun) onApplyAndRun(draft, appliedProfiles)
    else { onApply(draft); onProfilesApply?.(appliedProfiles) }
    onClose()
  }
  const handledRun = useRef(runRequest)
  useEffect(() => { if (runRequest !== handledRun.current) { handledRun.current = runRequest; apply(true) } }, [runRequest])
  const nodeOptions = (() => {
    const seen = new Set<string>(), options: {key:string;label:string}[] = []
    const terminals: Terminal[] = [...drawing.devices.flatMap(part => pinsFor(part).map(pin => ({device:part.id,pin}))), ...drawing.junctions.map(junction => ({junction:junction.id}))]
    for (const at of terminals) {
      const key=terminalKey(at), node=topology.nodes.get(key)
      if (!node || node === '0' || seen.has(node)) continue
      seen.add(node)
      const identity='device' in at ? `${at.device} · ${deviceCatalog[drawing.devices.find(part=>part.id===at.device)!.kind].pins[at.pin] ?? at.pin+1}` : at.junction
      options.push({key,label:`${node} · ${identity}（同网只列一项）`})
    }
    // Keep saved physical references visible even when another pin represents the same net.
    for (const at of [...(draft.initialConditions??[]).map(item=>item.at),...(draft.nodeSets??[]).map(item=>item.at),...(draft.noise?.negative?[draft.noise.negative]:[])]) {
      const key=terminalKey(at)
      if (!options.some(option=>option.key===key)) options.push({key,label:`${topology.nodes.get(key) ?? '已失效节点'} · ${key}`})
    }
    return options
  })()
  function readTerminal(key:string):Terminal|null { if(!key)return null;const split=key.lastIndexOf(':');return split>=0?{device:key.slice(0,split),pin:Number(key.slice(split+1))}:{junction:key} }
  const dcSource=drawing.devices.find(part=>part.id===(draft.dc?.sourceId || drawing.sourceId))
  function updateNodeSetting(kind:'initialConditions'|'nodeSets',index:number,patch:Partial<{at:Terminal;value:string}>) { setDraft(old=>({...old,[kind]:(old[kind]??[]).map((item,i)=>i===index?{...item,...patch}:item)})) }
  function nodeSettings(kind:'initialConditions'|'nodeSets',title:string,hint:string) {
    const rows=draft[kind]??[]
    return <details className="simulation-advanced-card"><summary><span>{title}</span><small>{rows.length?`${rows.length} 个节点`:'未设置'}</small></summary><div className="simulation-advanced-card-body"><p className="field-hint">{hint}</p>{rows.map((row,index)=><div className="simulation-node-row" key={index}><label className="field"><span>节点</span><select aria-label={`${title}节点 ${index+1}`} value={terminalKey(row.at)} onChange={event=>{const at=readTerminal(event.target.value);if(at)updateNodeSetting(kind,index,{at})}}>{nodeOptions.map(node=><option key={node.key} value={node.key}>{node.label}</option>)}</select></label><Field label={`${title}电压 ${index+1}`} value={row.value} placeholder="0V" onChange={value=>updateNodeSetting(kind,index,{value})}/><button type="button" aria-label={`移除${title} ${index+1}`} title="移除此节点" onClick={()=>setDraft(old=>({...old,[kind]:rows.length===1?undefined:rows.filter((_,i)=>i!==index)}))}><Trash2 size={15}/></button></div>)}<button type="button" disabled={!nodeOptions.some(node=>!rows.some(row=>topology.nodes.get(terminalKey(row.at))===topology.nodes.get(node.key)))||rows.length>=64} onClick={()=>{const available=nodeOptions.find(node=>!rows.some(row=>topology.nodes.get(terminalKey(row.at))===topology.nodes.get(node.key)));if(available){const at=readTerminal(available.key)!;setDraft(old=>({...old,[kind]:[...(old[kind]??[]),{at,value:'0V'}]}))}}}><Plus size={14}/>添加{title}</button></div></details>
  }
  return <div className={embedded ? `simulation-settings-embedded${modal?' workbench-window-backdrop simulation-settings-modal':''}` : 'workbench-window-backdrop simulation-settings-backdrop'} onMouseDown={event => { if (modal && event.target === event.currentTarget) onClose() }}>
    <section ref={panel} className={embedded ? 'simulation-settings-inline-panel' : 'workbench-window simulation-settings-window'} role={modal ? 'dialog' : 'region'} aria-modal={modal ? true : undefined} aria-label="仿真设置" tabIndex={-1} onKeyDown={event => { if (onApplyAndRun && ((event.ctrlKey || event.metaKey) && event.key === 'Enter' || event.key === 'F9')) { event.preventDefault(); event.stopPropagation(); apply(true) } }}>
      <header className="workbench-window-heading"><div><h2><Settings2 size={20}/>{newProfile?'添加仿真配置':'修改仿真配置'}</h2><p><span className="simulation-analysis-badge">{names[draft.analysis]}</span><span className="simulation-current-profile">{selectedProfile.name}</span></p></div><button aria-label="关闭仿真设置" onClick={onClose}><X size={18}/></button></header>
      {embedded && <div className="simulation-inline-tabs" role="tablist" aria-label="仿真设置分类" onKeyDown={navigatePages}>{pages.map(item => <button key={item.id} id={`${pageId}-${item.id}-tab`} role="tab" tabIndex={activePage === item.id ? 0 : -1} aria-selected={activePage === item.id} aria-controls={`${pageId}-${item.id}`} onClick={() => setPage(item.id)}>{item.name}</button>)}</div>}
      <div className="simulation-settings-body">
        {(profiles || newProfile)&&<details {...pageAttributes('profiles')} className={`simulation-profile-settings${embedded?' is-inline':''}`} open={embedded||newProfile}>
          <summary><span>配置 · {selectedProfile.name}</span><small>{profileDraft.profiles.length} 个配置 · 展开管理</small></summary>
          <div className="simulation-profile-manager"><div className="simulation-section-heading"><h3>仿真配置</h3><span>{profileDraft.profiles.length} / 24</span></div><label><span>当前配置</span><select aria-label="选择仿真配置" value={profileDraft.activeId} onChange={event=>selectProfile(event.target.value)}>{profileDraft.profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {names[p.settings.analysis]}</option>)}</select></label><label><span>配置名称</span><input aria-label="配置名称" maxLength={80} value={selectedProfile.name} onChange={event=>setProfileDraft(old=>({...old,profiles:old.profiles.map(p=>p.id===old.activeId?{...p,name:event.target.value}:p)}))}/></label><div className="simulation-profile-actions"><button type="button" onClick={()=>addProfile(false)} disabled={profileDraft.profiles.length>=24}><Plus size={14}/>新建配置</button><button type="button" onClick={()=>addProfile(true)} disabled={profileDraft.profiles.length>=24}><Copy size={14}/>复制配置</button><button type="button" className="simulation-delete-profile" onClick={removeProfile} disabled={profileDraft.profiles.length<2} title={profileDraft.profiles.length<2?'至少保留一个仿真配置':'删除当前草稿配置，应用后生效'}><Trash2 size={14}/>删除配置</button></div></div>
        </details>}

        <div hidden={embedded && activePage !== 'analysis'} className="editor-analysis-select" aria-label="分析类型">{(['ac', 'noise', 'tran', 'dc', 'op'] as Analysis[]).map(analysis => <button key={analysis} aria-pressed={draft.analysis === analysis} className={draft.analysis === analysis ? 'active' : ''} onClick={() => setDraft(old => ({ ...old, analysis }))}>{names[analysis]}</button>)}</div>
        <div className="simulation-settings-columns"><section {...pageAttributes('analysis')} className="simulation-analysis-fields"><h3>{names[draft.analysis]}</h3>
          {draft.analysis === 'ac' || draft.analysis === 'noise' ? <>
            <label className="field"><span>频率扫描方式</span><select aria-label="频率扫描方式" value={draft.ac.sweep ?? 'dec'} onChange={event => setDraft(old => ({ ...old, ac: { ...old.ac, sweep: event.target.value as 'dec' | 'oct' | 'lin' } }))}><option value="dec">十倍频程 · Decade</option><option value="oct">倍频程 · Octave</option><option value="lin">线性 · Linear</option></select></label>
            <div className="field-pair"><Field label="起始频率" value={draft.ac.start} onChange={start => setDraft(old => ({ ...old, ac: { ...old.ac, start } }))}/><Field label="终止频率" value={draft.ac.stop} onChange={stop => setDraft(old => ({ ...old, ac: { ...old.ac, stop } }))}/></div>
            <Field label={draft.ac.sweep === 'lin' ? '总采样点数' : draft.ac.sweep === 'oct' ? '每倍频程采样点' : '每十倍频程采样点'} type="number" value={draft.ac.points} onChange={points => setDraft(old => ({ ...old, ac: { ...old.ac, points: Number(points) } }))}/>
            <p className="field-hint">{draft.analysis === 'noise' ? '计算输出与输入等效噪声，单位 V/√Hz；噪声取决于实际器件模型，理想行为模型可能不含噪声。' : '先求直流工作点，再进行小信号分析。各电源的 AC 幅度与相位在器件参数中设置。'}</p>
            {draft.analysis === 'noise' && <><label className="field"><span>噪声输出负端</span><select aria-label="噪声输出负端" value={draft.noise?.negative ? terminalKey(draft.noise.negative) : ''} onChange={event => setDraft(old => ({ ...old, noise: { ...old.noise, negative: readTerminal(event.target.value) } }))}><option value="">GND · 单端输出</option>{nodeOptions.map(node => <option key={node.key} value={node.key}>{node.label}</option>)}</select><small className="field-hint">正端使用参考输出节点；选择负端可测差分噪声。参考源须为电压源。</small></label><Field label="噪声贡献明细间隔" type="number" value={draft.noise?.summaryInterval ?? ''} placeholder="留空使用求解器默认" hint="每隔多少个频率点输出器件噪声贡献；结果频点可能按此间隔输出，0 表示不输出明细。" onChange={value => setDraft(old => ({ ...old, noise: { ...old.noise, summaryInterval: value.trim() ? Number(value) : undefined } }))}/></>}
          </> : draft.analysis === 'tran' ? <>
            <div className="field-pair"><Field label="仿真时长" value={draft.tran.stop} onChange={stop => setDraft(old => ({ ...old, tran: { ...old.tran, stop } }))}/><Field label="最大步长" value={draft.tran.step} onChange={step => setDraft(old => ({ ...old, tran: { ...old.tran, step } }))}/></div>
            <div className="field-pair"><Field label="开始记录时间" value={draft.tran.start ?? ''} placeholder="0s" hint="仅控制结果从何时保存，电路仍从 0 开始积分。" onChange={start => setDraft(old => ({ ...old, tran: { ...old.tran, start: start.trim() || undefined } }))}/><Field label="输出采样步长" value={draft.tran.outputStep ?? ''} placeholder="留空沿用最大步长" hint="建议输出间隔与求解器最大步长分别设置；波形保留求解器实际自适应采样点。" onChange={outputStep => setDraft(old => ({ ...old, tran: { ...old.tran, outputStep: outputStep.trim() || undefined } }))}/></div>
            <label className="simulation-checkbox"><input aria-label="跳过初始直流工作点" type="checkbox" checked={draft.tran.uic ?? false} onChange={event => setDraft(old => ({ ...old, tran: { ...old.tran, uic: event.target.checked || undefined } }))}/><span>跳过初始直流工作点 · UIC</span></label><p className="field-hint">UIC 使用初始条件直接启动；仅在已明确电容电压、电感电流等初始状态时使用。激励波形在器件参数中调整。</p>
          </> : draft.analysis === 'dc' ? <>
            <label className="field"><span>DC 扫描源</span><select aria-label="DC 扫描源" value={draft.dc?.sourceId ?? ''} onChange={event => setDraft(old => ({ ...old, dc: { ...dcSweep(old), sourceId: event.target.value || undefined } }))}><option value="">沿用参考源 {drawing.sourceId || '（未选择）'}</option>{drawing.devices.filter(part => part.kind === 'V' || part.kind === 'I').map(part => <option key={part.id} value={part.id}>{part.id} · {part.kind === 'I' ? '电流源 / A' : '电压源 / V'}</option>)}</select><small className="field-hint">独立于输入参考源；其它电源保持各自 DC 数值。当前扫描单位：{dcSource?.kind === 'I' ? 'A（安培）' : 'V（伏特）'}。</small></label>
            <div className="field-pair"><Field label="扫描起点" value={dcSweep(draft).start} onChange={start => setDraft(old => ({ ...old, dc: { ...dcSweep(old), start } }))}/><Field label="扫描终点" value={dcSweep(draft).stop} onChange={stop => setDraft(old => ({ ...old, dc: { ...dcSweep(old), stop } }))}/></div><Field label="扫描步进" value={dcSweep(draft).step} hint="递增使用正步进；递减使用负步进。" onChange={step => setDraft(old => ({ ...old, dc: { ...dcSweep(old), step } }))}/>
          </> : <p className="field-hint">求解电路静态电压与支路电流。电源 DC 值在器件参数中设置；收敛初猜可在高级设置中指定。</p>}
          {command && <div className="simulation-command-preview"><span>SPICE 指令</span><div className="simulation-complete-command">{commonCommands && <code className="simulation-common-command">{commonCommands}</code>}<code className="analysis-command">{command}</code></div></div>}
        </section><section {...pageAttributes('reference')} className="simulation-reference-fields"><h3>输入与输出参考</h3>
          <label className="field"><span>参考电压源</span><select aria-label="参考电压源" value={drawing.sourceId} onChange={event => updateDrawing({ sourceId: event.target.value })}><option value="">请选择电压源</option>{drawing.devices.filter(part => part.kind === 'V').map(part => <option key={part.id} value={part.id}>{part.id} · 输入激励</option>)}</select><small className="field-hint">负端须接 GND。参考源用于传递函数和输入等效噪声；DC 扫描可独立选择源。各电源保留各自的波形设置。</small></label>
          <label className="field"><span>参考输出节点</span><select aria-label="参考输出节点" value={drawing.output ? terminalKey(drawing.output) : ''} onChange={event => { const key = event.target.value; const output: Terminal = key.includes(':') ? { device: key.split(':')[0], pin: Number(key.split(':')[1]) as Pin } : { junction: key }; updateDrawing({ output }) }}><option value="" disabled>请选择参考输出</option>{drawing.devices.flatMap(part => pinsFor(part).map(pin => <option key={`${part.id}:${pin}`} value={`${part.id}:${pin}`}>{part.id} · {deviceCatalog[part.kind].pins[pin]} ({topology.nodes.get(`${part.id}:${pin}`)})</option>))}{drawing.junctions.map(junction => <option key={junction.id} value={junction.id}>{junction.id}</option>)}</select><small className="field-hint">用于默认输出波形、传递函数与兼容导出。多点测量使用画布探针。</small></label>
        </section></div>
        {embedded ? <div {...pageAttributes('experiment')}><SimulationExperimentSettings key={selectedProfile.id} project={draft} onChange={setDraft} embedded/></div> : <details className="simulation-advanced-settings" open={advancedOpen} onToggle={event=>setAdvancedOpen(event.currentTarget.open)}><summary><span>温度与参数扫描</span><small>{draft.sweep ? `已启用 · ${draft.sweep.values.length} 个扫描值` : `${draft.temperature ?? 27}°C · 未启用扫描`}</small></summary><SimulationExperimentSettings key={selectedProfile.id} project={draft} onChange={setDraft}/></details>}
        <section {...pageAttributes('advanced')} className="simulation-common-advanced" aria-label="求解器与初始条件">
          <details className="simulation-advanced-card"><summary><span>求解器与精度</span><small>{Object.values(draft.solver??{}).filter(value=>value!==undefined).length ? '已自定义' : '继承默认'}</small></summary><div className="simulation-advanced-card-body"><p className="field-hint">留空继承工作台与 ngspice 默认值。ABSTOL 单位 A，VNTOL 单位 V；可输入 1e-12 等数值。更小的误差可能增加计算时间；Gear 适用于部分刚性电路，可能引入数值阻尼。</p><div className="field-pair"><label className="field"><span>积分方法</span><select aria-label="积分方法" value={draft.solver?.method ?? ''} onChange={event=>setDraft(old=>({...old,solver:{...old.solver,method:event.target.value as 'trap'|'gear'||undefined}}))}><option value="">继承默认</option><option value="trap">梯形积分 · Trap</option><option value="gear">Gear 积分</option></select></label><label className="field"><span>最大积分阶数</span><select aria-label="最大积分阶数" value={draft.solver?.maxord ?? ''} onChange={event=>setDraft(old=>({...old,solver:{...old.solver,maxord:event.target.value as '1'|'2'||undefined}}))}><option value="">继承默认</option><option value="1">1 阶</option><option value="2">2 阶</option></select></label></div><div className="simulation-solver-grid">{([
            ['reltol','相对误差 RELTOL','1e-5'],['abstol','电流绝对误差 ABSTOL','1e-12'],['vntol','电压绝对误差 VNTOL','1e-6'],['chgtol','电荷误差 CHGTOL','1e-14'],['gmin','最小电导 GMIN','1e-12'],['trtol','瞬态误差系数 TRTOL','7'],['itl1','DC 迭代上限 ITL1','100'],['itl4','瞬态迭代上限 ITL4','10'],
          ] as const).map(([key,label,placeholder])=><Field key={key} label={label} value={draft.solver?.[key]??''} placeholder={`默认 ${placeholder}`} onChange={value=>setDraft(old=>({...old,solver:{...old.solver,[key]:value.trim()||undefined}}))}/>)}</div><button type="button" onClick={()=>setDraft(old=>({...old,solver:undefined}))}>恢复求解器默认</button></div></details>
          {nodeSettings('initialConditions','初始条件 IC','指定节点初始电压；瞬态 UIC 时作为启动条件，未启用 UIC 时用于初始工作点求解。真实电容与电感状态仍由其器件参数决定。')}
          {nodeSettings('nodeSets','收敛初猜 NODESET','帮助求解器寻找直流工作点，不固定最终节点电压；适用于多个稳定工作点或难以收敛的电路。')}
        </section>
        {switches.length > 0&&<section {...pageAttributes('switches')} className="simulation-reference-fields" aria-label="配置触点状态"><h3>继电器 / 开关触点状态</h3><p className="field-hint">每个仿真配置独立保存以下触点状态；切换配置和运行此配置时自动恢复。线圈驱动的继电器仍由控制电压决定状态。</p>{(embedded ? switches.slice(currentSwitchPage * 3, currentSwitchPage * 3 + 3) : switches).map(device=><label className="field" key={device.id}><span>{device.id}</span><select aria-label={`${device.id} 触点状态`} value={device.value} onChange={event=>{const value=event.target.value;updateDrawing({devices:drawing.devices.map(part=>part.id===device.id?{...part,value}:part)})}}><option value="ON">闭合 ON</option><option value="OFF">断开 OFF</option></select></label>)}{embedded && switchPages > 1 && <nav className="simulation-inline-pagination" aria-label="触点分页"><button disabled={!currentSwitchPage} onClick={() => setSwitchPage(currentSwitchPage - 1)}>上一页</button><span>{currentSwitchPage + 1} / {switchPages}</span><button disabled={currentSwitchPage === switchPages - 1} onClick={() => setSwitchPage(currentSwitchPage + 1)}>下一页</button></nav>}</section>}
        {!embedded && error && <p className="simulation-settings-error" role="alert">{error}</p>}
      </div>
      {embedded && error && <p className="simulation-settings-error" role="alert">{error}</p>}
      {!error && runError && <p className="simulation-settings-run-warning" role="status">电路暂不能运行：{runError}。可先应用设置，修复连接后运行。</p>}
      <footer className="workbench-window-footer"><div className={`simulation-draft-state${dirty?' is-dirty':''}`} role="status"><span>{dirty?'草稿尚未应用':'当前已应用配置'}</span><small title="界面单位：M 表示兆，m 表示毫；原始 SPICE 网表中兆请使用 Meg。">单位：m 毫 · M 兆</small></div><div className="simulation-footer-actions"><button onClick={onClose}>取消</button><button className={onApplyAndRun?'':'primary'} disabled={!!error} onClick={()=>apply()}><Check size={16}/>应用设置</button>{onApplyAndRun&&<button className="primary" title="应用当前设置并运行 · Ctrl+Enter / F9" disabled={!!error||!!runError||busy} onClick={()=>apply(true)}><Play size={14}/>应用并运行</button>}</div></footer>
    </section>
  </div>
}
