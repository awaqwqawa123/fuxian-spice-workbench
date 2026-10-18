import { newProject, type Project, type TemplateId } from './circuit'
import { connect, emptyDrawing, terminal, type Device, type Drawing } from './drawing'

export function editableProject(p: Project = newProject()): Project {
  if (p.template === 'custom') return structuredClone(p)
  const high = p.template === 'rc-highpass', rlc = p.template === 'rlc-lowpass'
  const series = high ? 'C1' : 'R1', shunt = high ? 'R1' : 'C1'
  const devices: Device[] = [
    { id:'V1',kind:'V',value:p.source.dc,x:200,y:320,rotation:90 },
    { id:series,kind:high ? 'C' : 'R',value:high ? p.values.C1 : p.values.R1,x:rlc ? 420 : 460,y:200,rotation:0 },
    ...(rlc ? [{ id:'L1',kind:'L' as const,value:p.values.L1,x:600,y:200,rotation:0 as const }] : []),
    { id:shunt,kind:high ? 'R' : 'C',value:high ? p.values.R1 : p.values.C1,x:820,y:320,rotation:90 },
    { id:'G1',kind:'GND',value:'',x:200,y:440,rotation:0 },
    { id:'G2',kind:'GND',value:'',x:820,y:440,rotation:0 },
  ]
  let drawing: Drawing = { ...emptyDrawing(),devices,sourceId:'V1',output:terminal(shunt,0) }
  drawing = connect(drawing,terminal('V1',0),terminal(series,0),'vh')
  if (rlc) drawing = connect(drawing,terminal('R1',1),terminal('L1',0))
  drawing = connect(drawing,terminal(rlc ? 'L1' : series,1),terminal(shunt,0))
  drawing = connect(drawing,terminal('V1',1),terminal('G1'))
  drawing = connect(drawing,terminal(shunt,1),terminal('G2'))
  return { ...structuredClone(p),schemaVersion:2,template:'custom',title:`${p.title} · 自由绘制`,drawing }
}
export function blankProject(): Project { return { ...newProject(),schemaVersion:2,template:'custom',title:'未命名电路',drawing:emptyDrawing() } }
export function editorTemplate(id: TemplateId): Project { return editableProject(newProject(id)) }

export interface UndoState<T> { past:T[]; present:T; future:T[] }
export function remember<T>(state: UndoState<T>, next: T): UndoState<T> {
  if (JSON.stringify(state.present) === JSON.stringify(next)) return state
  return { past:[...state.past,state.present].slice(-60),present:next,future:[] }
}
export function undo<T>(state: UndoState<T>): UndoState<T> { return state.past.length ? { past:state.past.slice(0,-1),present:state.past[state.past.length-1],future:[state.present,...state.future] } : state }
export function redo<T>(state: UndoState<T>): UndoState<T> { return state.future.length ? { past:[...state.past,state.present],present:state.future[0],future:state.future.slice(1) } : state }
