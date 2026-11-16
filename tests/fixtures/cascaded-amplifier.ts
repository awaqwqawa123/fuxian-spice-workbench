import { connect, emptyDrawing, terminal, type Device, type Drawing, type Terminal } from '../../src/core/drawing'

/** Intentionally crowded input. The topology is two ordinary non-inverting
 * stages with local gain/compensation, an interstage RC and shared supplies. */
export function cascadedAmplifier():Drawing {
  const device=(id:string,kind:Device['kind'],value:string,rotation:Device['rotation']=0):Device=>({id,kind,value,rotation,x:400,y:300})
  let drawing:Drawing={...emptyDrawing(),sourceId:'V1',output:terminal('U2',2),devices:[
    {...device('V1','V','1',90),params:{waveform:'sine',offset:'0',amplitude:'1',frequency:'1k'}},
    device('U1','OPA','100k'),device('U2','OPA','100k'),
    device('R1','R','10k',90),device('R2','R','100k'),device('C1','C','10p'),
    device('R3','R','1k'),device('C2','C','10n',90),
    device('R4','R','10k',90),device('R5','R','20k'),
    device('R6','R','100k',90),
    device('V2','V','15',90),device('V3','V','-15',90),
    ...Array.from({length:7},(_,index)=>device(`G${index+1}`,'GND','')),
  ],labels:[{id:'N1',name:'STAGE_1',at:terminal('U1',2)},{id:'N2',name:'OUT',at:terminal('U2',2)}]}
  const pairs:[Terminal,Terminal][]=[
    [terminal('V1'),terminal('U1')],[terminal('V1',1),terminal('G1')],
    [terminal('U1',1),terminal('R1')],[terminal('R1',1),terminal('G2')],
    [terminal('U1',1),terminal('R2')],[terminal('U1',2),terminal('R2',1)],
    [terminal('U1',1),terminal('C1')],[terminal('U1',2),terminal('C1',1)],
    [terminal('U1',2),terminal('R3')],[terminal('R3',1),terminal('U2')],
    [terminal('U2'),terminal('C2')],[terminal('C2',1),terminal('G3')],
    [terminal('U2',1),terminal('R4')],[terminal('R4',1),terminal('G4')],
    [terminal('U2',1),terminal('R5')],[terminal('U2',2),terminal('R5',1)],
    [terminal('U2',2),terminal('R6')],[terminal('R6',1),terminal('G5')],
    [terminal('V2'),terminal('U1',3)],[terminal('V2'),terminal('U2',3)],
    [terminal('V3'),terminal('U1',4)],[terminal('V3'),terminal('U2',4)],
    [terminal('V2',1),terminal('G6')],[terminal('V3',1),terminal('G7')],
  ]
  for(const [from,to]of pairs)drawing=connect(drawing,from,to)
  return drawing
}
