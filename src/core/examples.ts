import { blankProject } from './editor'
import { connect, setNetLabel, terminal, type Device, type Drawing, type Pin, type Rotation } from './drawing'
import type { Project } from './circuit'

export const advancedExamples = [
  { id:'rectifier', name:'二极管半波整流', detail:'5 V / 50 Hz · 瞬态', tag:'D' },
  { id:'diode-sweep', name:'二极管 DC 扫描', detail:'−1 → 1 V · 限流 1k', tag:'.dc' },
  { id:'bjt-amplifier', name:'NPN 共射放大器', detail:'偏置 0.75 V · AC', tag:'Q' },
  { id:'mos-switch', name:'NMOS 开关特性', detail:'栅压 0 → 5 V · DC', tag:'M' },
  { id:'opamp-gain', name:'运放同相放大器', detail:'闭环增益 10 · AC', tag:'OP' },
] as const
export type ExampleId = typeof advancedExamples[number]['id']

export function exampleProject(id:ExampleId):Project {
  const p=blankProject()
  p.title=advancedExamples.find(e=>e.id===id)!.name
  let d:Drawing=p.drawing!
  const part=(id:string,kind:Device['kind'],value:string,x:number,y:number,rotation:Rotation=0)=>{d.devices.push({id,kind,value,x,y,rotation})}
  const wire=(a:string,ap:Pin,b:string,bp:Pin=0,bend:'hv'|'vh'='hv')=>{d=connect(d,terminal(a,ap),terminal(b,bp),bend)}
  const label=(a:string,pin:Pin,name:string)=>{d=setNetLabel(d,terminal(a,pin),name)}
  part('V1','V','5V',160,320,90);part('G1','GND','',160,460)
  wire('V1',1,'G1');d.sourceId='V1'
  if(id==='rectifier'||id==='diode-sweep'){
    const rect=id==='rectifier'
    part(rect?'D1':'R1',rect?'D':'R',rect?'D_SI':'1k',440,200)
    part(rect?'R1':'D1',rect?'R':'D',rect?'1k':'D_SI',800,320,90)
    part('G2','GND','',800,460)
    const series=rect?'D1':'R1',shunt=rect?'R1':'D1'
    wire('V1',0,series,0,'vh');wire(series,1,shunt);wire(shunt,1,'G2')
    d.output=terminal(shunt);label(shunt,0,rect?'RECT':'DIODE')
    p.source={...p.source,amplitude:'5V',frequency:'50Hz',offset:'0V',dc:'1V'}
    p.analysis=rect?'tran':'dc';p.tran={stop:'60ms',step:'20us'};p.dc={start:'-1V',stop:'1V',step:'10mV'}
  }else if(id==='bjt-amplifier'||id==='mos-switch'){
    const bjt=id==='bjt-amplifier',active=bjt?'Q1':'M1'
    part(active,bjt?'Q':'M',bjt?'Q_NPN':'M_NMOS',720,320)
    part('R2','R',bjt?'2k':'1k',740,160,90);part('G2','GND','',740,460)
    part('V2','V','5V',1040,320,90);part('G3','GND','',1040,460)
    wire('V2',1,'G3');label('V2',0,'VCC');label('R2',0,'VCC')
    wire('R2',1,active,0);wire(active,2,'G2')
    if(bjt){part('R1','R','10k',440,320);wire('V1',0,'R1',0);wire('R1',1,active,1)}else wire('V1',0,active,1)
    d.output=terminal(active,0);label(active,0,'OUT');label(active,1,bjt?'BASE':'GATE')
    p.source={...p.source,amplitude:bjt?'10mV':'5V',offset:bjt?'750mV':'0V',dc:bjt?'750mV':'5V',waveform:bjt?'sine':'square'}
    p.analysis=bjt?'ac':'dc';p.dc={start:'0V',stop:'5V',step:'50mV'}
  }else{
    // Voltage-controlled voltage source with high finite gain, no hidden power rails.
    part('E1','OP','100k',640,300)
    part('R1','R','10k',480,440);part('R2','R','90k',800,440)
    part('G2','GND','',360,500);part('R3','R','10k',980,340,90);part('G3','GND','',980,500)
    wire('V1',0,'E1',0);wire('R1',0,'G2',0,'vh');wire('R1',1,'E1',1,'vh')
    wire('R1',1,'R2');wire('E1',2,'R2',1);wire('E1',2,'R3');wire('R3',1,'G3')
    d.output=terminal('E1',2);label('E1',2,'OUT');label('E1',1,'FB')
    p.source={...p.source,amplitude:'100mV',dc:'100mV',offset:'0V'}
    p.analysis='ac'
  }
  p.drawing=d
  return p
}
