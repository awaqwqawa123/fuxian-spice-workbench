import { blankProject } from './editor'
import { connect,setNetLabel,terminal,type Device,type Drawing,type Pin,type Rotation } from './drawing'
import type { Project } from './circuit'

export const deviceExamples = [
  {id:'switch-load',name:'手动开关与负载',detail:'ON / OFF · 有限接触电阻',tag:'SW'},
  {id:'voltage-switch',name:'电压控制开关',detail:'控制电压扫描 · 迟滞触点',tag:'S'},
  {id:'relay-changeover',name:'继电器常开 / 常闭',detail:'R/L 线圈 · SPDT 触点 · 瞬态',tag:'K'},
  {id:'ldo-regulator',name:'LDO 稳压与压差',detail:'输入 0 → 6 V · 输出 3.3 V',tag:'LDO'},
  {id:'transformer-ratio',name:'变压器 1:2',detail:'双绕组 · 耦合电感 · AC',tag:'T'},
] as const
export type DeviceExampleId=typeof deviceExamples[number]['id']

export function deviceExampleProject(id:DeviceExampleId):Project {
  const p=blankProject();p.title=deviceExamples.find(e=>e.id===id)!.name
  let d:Drawing=p.drawing!
  const part=(id:string,kind:Device['kind'],value:string,x:number,y:number,rotation:Rotation=0)=>{d.devices.push({id,kind,value,x,y,rotation})}
  const wire=(a:string,ap:Pin,b:string,bp:Pin=0,bend:'hv'|'vh'='hv')=>{d=connect(d,terminal(a,ap),terminal(b,bp),bend)}
  const label=(a:string,pin:Pin,name:string)=>{d=setNetLabel(d,terminal(a,pin),name)}
  part('V1','V','5V',160,320,90);part('G1','GND','',160,480);wire('V1',1,'G1');d.sourceId='V1'
  p.analysis='op';p.source={...p.source,dc:'5V',frequency:'10Hz'}
  if(id==='switch-load'){
    part('SW1','SW','ON',460,240);part('R1','R','1k',860,320,90);part('G2','GND','',860,480)
    wire('V1',0,'SW1',0,'vh');wire('SW1',1,'R1');wire('R1',1,'G2');d.output=terminal('R1');label('R1',0,'OUT')
  }else if(id==='ldo-regulator'){
    part('U1','LDO','3.3V',540,240);part('R1','R','100',860,320,90);part('G2','GND','',540,480);part('G3','GND','',860,480)
    wire('V1',0,'U1',0,'vh');wire('U1',1,'G2');wire('U1',2,'R1');wire('R1',1,'G3');d.output=terminal('U1',2);label('U1',2,'OUT')
    p.analysis='dc';p.dc={start:'0V',stop:'6V',step:'50mV'}
  }else if(id==='transformer-ratio'){
    part('T1','XFMR','2',520,280);part('R1','R','10k',860,320,90);part('G2','GND','',460,480);part('G3','GND','',660,480);part('G4','GND','',860,480)
    wire('V1',0,'T1',0,'vh');wire('T1',1,'G2');wire('T1',2,'R1');wire('T1',3,'G3');wire('R1',1,'G4')
    d.output=terminal('T1',2);label('T1',2,'SECONDARY');p.analysis='ac';p.source.dc='0V';p.ac={start:'100Hz',stop:'100kHz',points:50}
  }else{
    part('V2','V','5V',1040,400,90);part('G2','GND','',1040,520);wire('V2',1,'G2');label('V2',0,'VCC')
    if(id==='voltage-switch'){
      part('S1','VSW','SW_GENERIC',520,280);part('R1','R','1k',780,360,90);part('G3','GND','',780,520);part('G4','GND','',540,520)
      label('S1',0,'VCC');wire('S1',1,'R1');wire('R1',1,'G3');wire('V1',0,'S1',2);wire('S1',3,'G4');d.output=terminal('R1');label('R1',0,'OUT')
      p.analysis='dc';p.dc={start:'0V',stop:'5V',step:'50mV'}
    }else{
      part('K1','RELAY','RELAY_GENERIC',500,280);part('R1','R','1k',780,140,0);part('R2','R','1k',860,400,90)
      part('G3','GND','',960,220);part('G4','GND','',860,520);part('G5','GND','',420,520)
      wire('V1',0,'K1',0);wire('K1',1,'G5');label('K1',2,'VCC');wire('K1',3,'R1',0,'vh');wire('R1',1,'G3');wire('K1',4,'R2');wire('R2',1,'G4')
      d.output=terminal('K1',3);label('K1',3,'NO');label('K1',4,'NC');label('K1',0,'COIL')
      p.analysis='tran';p.source={...p.source,amplitude:'2.5V',offset:'2.5V',dc:'0V',frequency:'10Hz',waveform:'sine'};p.tran={stop:'200ms',step:'100us'}
    }
  }
  p.drawing=d;return p
}
