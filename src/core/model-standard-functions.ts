import type { ImportedSpiceModel } from './spice-models'
import { parseModelSymbol, type ModelSymbol } from './model-symbol'
import type { FunctionalSymbolFamily } from './model-functional-symbol'
import { namedFunctionalPinRole, type FunctionalPinEvidence } from './model-pin-evidence'

type Point={x:number;y:number;label:string}
type Primitive=NonNullable<ModelSymbol['geometry']>[number]
const line=(...coords:number[]):Primitive=>({type:'line',coords})
const circle=(...coords:number[]):Primitive=>({type:'circle',coords})
const rectangle=(...coords:number[]):Primitive=>({type:'rectangle',coords})
const context=(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence)=>`${model.id}\n${model.name}\n${model.detail}\n${model.metadata.type??''}\n${model.deviceInfo?.function??''}\n${evidence?.text??''}`
const rolesFor=(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):string[]|undefined=>{
  if(evidence?.roles?.length===model.pins.length)return evidence.roles
  const named=model.pins.map(namedFunctionalPinRole)
  return named.every(Boolean)?named as string[]:evidence?.roles&&evidence.roles.length===model.pins.length?evidence.roles:undefined
}
const exactRoles=(roles:readonly string[]|undefined,required:readonly string[],optional:readonly string[]=[]):roles is readonly string[]=>!!roles&&required.every(role=>roles.filter(value=>value===role).length===1)&&roles.every(role=>required.includes(role)||optional.includes(role))&&new Set(roles).size===roles.length
function finish(model:ImportedSpiceModel,roles:readonly string[],points:Record<string,Point>,geometry:Primitive[],annotations:NonNullable<ModelSymbol['annotations']>=[]):ModelSymbol{
  if(roles.some(role=>!points[role]))throw new Error('未能确认全部端口的位置')
  return parseModelSymbol({version:1,shape:'ltspice',origin:'standard',title:model.id.slice(0,32),pins:roles.map((role,index)=>({index,...points[role]})),geometry,...(annotations.length?{annotations}:{})},'X',model.pins)
}
function concreteType(model:ImportedSpiceModel,group:RegExp=/NPN|PNP|NMOS|PMOS|NJF|PJF/):string|undefined{
  const types=new Set([...model.spice.matchAll(/^\s*\.model\s+\S+\s+(NPN|PNP|NMOS|PMOS|NJF|PJF)\b/gim)].map(match=>match[1].toUpperCase()).filter(type=>group.test(type)))
  return types.size===1?[...types][0]:undefined
}

function amplifierRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)
  if(!roles||new Set(roles).size!==roles.length)return undefined
  const channelRoles=roles.filter(role=>/^(?:input-plus|input-minus|output)(?::[A-H1-8])?$/.test(role))
  if(!channelRoles.length)return undefined
  const channels=[...new Set(channelRoles.map(role=>role.split(':')[1]??''))]
  if(channels.length>8||channels.some(channel=>['input-plus','input-minus','output'].some(base=>!roles.includes(`${base}${channel?`:${channel}`:''}`))))return undefined
  const extras=roles.filter(role=>!channelRoles.includes(role))
  return extras.every(role=>['positive-supply','negative-supply','ground','enable','shutdown','shutdown-low'].includes(role))?roles:undefined
}
function drawAmplifier(model:ImportedSpiceModel,roles:readonly string[],comparator=false):ModelSymbol{
  const channels=[...new Set(roles.filter(role=>role.startsWith('input-plus')).map(role=>role.split(':')[1]??''))].sort()
  const points:Record<string,Point>={},geometry:Primitive[]=[],annotations:NonNullable<ModelSymbol['annotations']>=[]
  channels.forEach((channel,index)=>{
    const y=(index-(channels.length-1)/2)*100,suffix=channel?`:${channel}`:''
    geometry.push(line(-20,y-30,-20,y+30),line(-20,y-30,30,y),line(30,y,-20,y+30),line(-40,y-20,-20,y-20),line(-40,y+20,-20,y+20),line(30,y,50,y))
    points[`input-plus${suffix}`]={x:-40,y:y-20,label:`IN${channel}+`};points[`input-minus${suffix}`]={x:-40,y:y+20,label:`IN${channel}-`};points[`output${suffix}`]={x:50,y,label:`OUT${channel}`}
    annotations.push({text:'+',x:-16,y:y-15,size:8},{text:'−',x:-16,y:y+24,size:8})
    if(comparator)annotations.push({text:'CMP',x:-12,y:y+4,size:7})
  })
  const top=-(channels.length-1)*50-50,bottom=(channels.length-1)*50+50
  if(roles.includes('positive-supply')){points['positive-supply']={x:0,y:top,label:'V+'};geometry.push(line(0,top,0,top+30))}
  const low=roles.includes('negative-supply')?'negative-supply':roles.includes('ground')?'ground':undefined
  if(low){points[low]={x:0,y:bottom,label:low==='ground'?'GND':'V−'};geometry.push(line(0,bottom-30,0,bottom))}
  if(roles.includes('ground')&&low!=='ground'){points.ground={x:20,y:bottom,label:'GND'};geometry.push(line(20,bottom-30,20,bottom))}
  ;['enable','shutdown','shutdown-low'].filter(role=>roles.includes(role)).forEach((role,index)=>{points[role]={x:40+20*index,y:bottom,label:role==='enable'?'EN':role==='shutdown-low'?'nSHDN':'SHDN'};geometry.push(line(points[role].x,bottom-20,points[role].x,bottom))})
  return finish(model,roles,points,geometry,annotations)
}

function drawDiode(model:ImportedSpiceModel,roles:readonly string[],evidence?:FunctionalPinEvidence):ModelSymbol{
  const points={anode:{x:-40,y:0,label:'A'},cathode:{x:40,y:0,label:'K'}}
  const geometry=[line(-40,0,-14,0),line(-14,-16,-14,16),line(-14,-16,14,0),line(14,0,-14,16),line(14,-16,14,16),line(14,0,40,0)]
  if(/\bzener\b/i.test(context(model,evidence)))geometry.push(line(14,-16,20,-22),line(14,16,8,22))
  if(/\bschottky\b/i.test(context(model,evidence)))geometry.push(line(14,-16,22,-16),line(22,-16,22,-10),line(14,16,6,16),line(6,16,6,10))
  if(/\b(?:light[- ]emitting diode|LED)\b/i.test(context(model,evidence)))geometry.push(line(-2,-22,12,-36),line(12,-36,5,-35),line(12,-36,11,-29),line(6,-14,20,-28),line(20,-28,13,-27),line(20,-28,19,-21))
  if(/\b(?:photodiode|photo diode)\b/i.test(context(model,evidence)))geometry.push(line(14,-36,0,-22),line(0,-22,1,-29),line(0,-22,7,-23),line(22,-28,8,-14),line(8,-14,9,-21),line(8,-14,15,-15))
  if(/\b(?:varactor|varicap|tuning diode)\b/i.test(context(model,evidence)))geometry.push(line(22,-16,22,16))
  const family=/\b(?:photodiode|photo diode)\b/i.test(context(model,evidence))?'photodiode':/\b(?:varactor|varicap|tuning diode)\b/i.test(context(model,evidence))?'varactor':/\bzener\b/i.test(context(model,evidence))?'zener-diode':/\bschottky\b/i.test(context(model,evidence))?'schottky-diode':/\b(?:LED|light[- ]emitting)\b/i.test(context(model,evidence))?'led':'diode-subcircuit'
  return {...finish(model,roles,points,geometry),family}
}
function drawTransistor(model:ImportedSpiceModel,roles:readonly string[],technology:string):ModelSymbol{
  const bjt=/PNP|NPN/.test(technology),jfet=/NJF|PJF/.test(technology),positive=/NPN|NMOS|NJF/.test(technology)
  const points:Record<string,Point>=bjt?{base:{x:-40,y:0,label:'B'},collector:{x:20,y:-40,label:'C'},emitter:{x:20,y:40,label:'E'}}:{gate:{x:-40,y:0,label:'G'},drain:{x:20,y:-40,label:'D'},source:{x:20,y:40,label:'S'}}
  const geometry:Primitive[]=[circle(-26,-30,34,30),line(-40,0,-12,0),line(-12,-18,-12,18),line(20,-40,20,-18),line(20,18,20,40)]
  if(bjt){geometry.push(line(-12,-10,20,-18),line(-12,10,20,18));const ax=positive?16:-4,ay=positive?17:12;geometry.push(line(ax,ay,ax+(positive?-7:7),ay-6),line(ax,ay,ax+(positive?-8:6),ay+3));if(roles.includes('body')){points.body={x:40,y:0,label:'SUB'};geometry.push(line(34,0,40,0))}}
  else{
    geometry.push(line(jfet?-12:-4,-18,jfet?-12:-4,18),line(jfet?-12:-4,-18,20,-18),line(jfet?-12:-4,18,20,18))
    if(jfet){const ax=-12;geometry.push(line(ax,0,ax+(positive?-7:7),-5),line(ax,0,ax+(positive?-7:7),5))}
    if(roles.includes('body')){points.body={x:40,y:0,label:'BULK'};geometry.push(line(-4,0,40,0),line(4,0,4+(positive?7:-7),-5),line(4,0,4+(positive?7:-7),5))}
    else if(!jfet){geometry.push(line(-4,0,10,0),line(10,0,10,18),line(4,0,4+(positive?7:-7),-5),line(4,0,4+(positive?7:-7),5))}
  }
  return finish(model,roles,points,geometry,[{text:technology,x:-18,y:54,size:7}])
}

function passiveType(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):'R'|'C'|'L'|undefined{
  const text=context(model,evidence)
  if(/\b(?:resistor|resistance)\b/i.test(text))return 'R'
  if(/\b(?:capacitor|capacitance)\b/i.test(text))return 'C'
  if(/\b(?:inductor|inductance|choke)\b/i.test(text))return 'L'
  return undefined
}
function passiveRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)
  return exactRoles(roles,['positive','negative'])?roles:undefined
}
function drawPassive(model:ImportedSpiceModel,roles:readonly string[],type:'R'|'C'|'L'):ModelSymbol{
  const geometry=[line(-40,0,-20,0),line(20,0,40,0)]
  if(type==='R')geometry.push(rectangle(-20,-8,20,8))
  else if(type==='C')geometry.push(line(-6,-20,-6,20),line(6,-20,6,20),line(-20,0,-6,0),line(6,0,20,0))
  else for(let x=-20;x<20;x+=10)geometry.push({type:'arc',coords:[x,-8,x+10,8,x,0,x+10,0]})
  return {...finish(model,roles,{positive:{x:-40,y:0,label:'P'},negative:{x:40,y:0,label:'N'}},geometry,[{text:type,x:-3,y:25,size:8}]),family:type==='R'?'resistor':type==='C'?'capacitor':'inductor'}
}

function regulatorRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)
  return exactRoles(roles,['input','output'],['ground','reference','feedback','enable','shutdown','sense'])&&roles.some(role=>['ground','reference'].includes(role))?roles:undefined
}
function drawRegulator(model:ImportedSpiceModel,roles:readonly string[]):ModelSymbol{
  const points:Record<string,Point>={input:{x:-50,y:0,label:'VIN'},output:{x:50,y:0,label:'VOUT'}}
  const geometry=[rectangle(-25,-25,25,25),line(-50,0,-25,0),line(25,0,50,0)],extras=roles.filter(role=>!['input','output'].includes(role))
  extras.forEach((role,index)=>{const x=(index-(extras.length-1)/2)*20;points[role]={x,y:50,label:{ground:'GND',reference:'ADJ',feedback:'FB',enable:'EN',shutdown:'SHDN',sense:'SENSE'}[role]??role};geometry.push(line(x,25,x,50))})
  return finish(model,roles,points,geometry,[{text:'REG',x:-12,y:4,size:8}])
}
function optocouplerRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)?.map(role=>role==='anode'?'led-anode':role==='cathode'?'led-cathode':role)
  return exactRoles(roles,['led-anode','led-cathode','collector','emitter'],['base'])?roles:undefined
}
function drawOptocoupler(model:ImportedSpiceModel,roles:readonly string[]):ModelSymbol{
  const points:Record<string,Point>={'led-anode':{x:-50,y:-30,label:'LED A'},'led-cathode':{x:-50,y:30,label:'LED K'},collector:{x:50,y:-30,label:'C'},emitter:{x:50,y:30,label:'E'}}
  const geometry=[rectangle(-35,-40,35,40),line(-50,-30,-20,-30),line(-20,-30,-20,-12),line(-20,12,-20,30),line(-20,30,-50,30),line(-30,-12,-10,-12),line(-30,-12,-20,12),line(-20,12,-10,-12),line(-30,12,-10,12),line(15,-18,15,18),line(15,-10,30,-20),line(15,10,30,20),line(30,-20,30,-30),line(30,-30,50,-30),line(30,20,30,30),line(30,30,50,30),line(-5,-5,8,-15),line(8,-15,1,-14),line(8,-15,5,-8),line(-5,8,8,-2),line(8,-2,1,-1),line(8,-2,5,5)]
  if(roles.includes('base')){points.base={x:50,y:0,label:'B'};geometry.push(line(15,0,50,0))}
  return finish(model,roles,points,geometry)
}
function transformerRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)
  return exactRoles(roles,['primary-positive','primary-negative','secondary-positive','secondary-negative'])?roles:undefined
}
function drawTransformer(model:ImportedSpiceModel,roles:readonly string[]):ModelSymbol{
  const points={'primary-positive':{x:-40,y:-30,label:'P1'},'primary-negative':{x:-40,y:30,label:'P2'},'secondary-positive':{x:40,y:-30,label:'S1'},'secondary-negative':{x:40,y:30,label:'S2'}}
  const geometry=[line(-40,-30,-16,-30),line(-40,30,-16,30),line(16,-30,40,-30),line(16,30,40,30),line(-4,-30,-4,30),line(4,-30,4,30)]
  for(let y=-30;y<30;y+=15){geometry.push({type:'arc',coords:[-23,y,-9,y+15,-16,y,-16,y+15]},{type:'arc',coords:[9,y,23,y+15,16,y+15,16,y]})}
  return finish(model,roles,points,geometry)
}
function switchRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)
  return exactRoles(roles,['positive','negative','control-positive','control-negative'])?roles:undefined
}
function drawSwitch(model:ImportedSpiceModel,roles:readonly string[]):ModelSymbol{
  return finish(model,roles,{positive:{x:-40,y:0,label:'P'},negative:{x:40,y:0,label:'N'},'control-positive':{x:-10,y:40,label:'CTRL+'},'control-negative':{x:10,y:40,label:'CTRL−'}},[line(-40,0,-15,0),line(15,0,40,0),circle(-17,-2,-13,2),circle(13,-2,17,2),line(-15,0,12,-15),line(-10,40,-10,25),line(10,25,10,40),line(-10,25,10,25)])
}

const seriesReferenceName=/^(?:REF(?:0[125]|10|19[1-9]|[3456]\d{3})[A-Z0-9_.-]*|ADR\d+[A-Z0-9_.-]*)(?:\/[A-Z0-9_-]+)?$/i
export function isSeriesVoltageReference(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):boolean{
  return evidence?.family==='series-voltage-reference'||seriesReferenceName.test(model.id)||/\b(?:series[- ](?:voltage )?reference|precision voltage reference)\b/i.test(context(model,evidence))
}
function seriesReferenceRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)?.map(role=>role==='positive-supply'?'input':role)
  if(!roles||new Set(roles).size!==roles.length||!roles.includes('input'))return undefined
  if(Number(roles.includes('output'))+Number(roles.includes('output-force'))!==1)return undefined
  if(roles.includes('output-sense')&&!roles.includes('output-force'))return undefined
  if(!roles.some(role=>['ground','ground-force','negative-supply'].includes(role)))return undefined
  const accepted=['input','output','output-force','output-sense','ground','ground-force','ground-sense','negative-supply','enable','shutdown','shutdown-low','trim','temperature','noise-reduction','bypass','reference']
  return roles.every(role=>accepted.includes(role))?roles:undefined
}
function drawSeriesReference(model:ImportedSpiceModel,roles:readonly string[]):ModelSymbol{
  const points:Record<string,Point>={},geometry:Primitive[]=[rectangle(-30,-30,30,30)]
  const terminals=[
    ['input',-60,-10,'VIN'],['output',60,-10,'VREF'],['output-force',60,-10,'OUTF'],['output-sense',60,10,'OUTS'],
    ['enable',-60,10,'EN'],['shutdown',-60,10,'SHDN'],['shutdown-low',-60,10,'nSHDN'],
    ['ground',0,60,'GND'],['ground-force',-10,60,'GNDF'],['ground-sense',10,60,'GNDS'],['negative-supply',0,60,'V−'],
    ['trim',-20,-60,'TRIM'],['temperature',0,-60,'TEMP'],['noise-reduction',20,-60,'NR'],['bypass',20,-60,'BYP'],['reference',-20,-60,'ADJ'],
  ] as const
  const occupied=new Set<string>()
  for(const [role,x,y,label] of terminals)if(roles.includes(role)){
    const point:Point={x,y,label}
    while(occupied.has(`${point.x},${point.y}`)){if(Math.abs(point.x)===60)point.y+=10;else point.x+=10}
    occupied.add(`${point.x},${point.y}`);points[role]=point
    geometry.push(line(point.x,point.y,point.x===-60?-30:point.x===60?30:point.x,point.y===-60?-30:point.y===60?30:point.y))
  }
  return finish(model,roles,points,geometry,[{text:'VREF',x:-15,y:4,size:8}])
}
function instrumentationRoles(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):readonly string[]|undefined{
  const roles=rolesFor(model,evidence)
  return exactRoles(roles,['input-plus','input-minus','output','positive-supply'],['negative-supply','ground','reference','gain-positive','gain-negative','enable','shutdown','shutdown-low'])?roles:undefined
}
function drawSpecialAmplifier(model:ImportedSpiceModel,roles:readonly string[],differential=false):ModelSymbol{
  const points:Record<string,Point>={'input-plus':{x:-60,y:-20,label:'IN+'},'input-minus':{x:-60,y:20,label:'IN−'},'positive-supply':{x:0,y:-60,label:'V+'},output:{x:60,y:0,label:'OUT'},'output-plus':{x:60,y:-20,label:'OUT+'},'output-minus':{x:60,y:20,label:'OUT−'}}
  const geometry:Primitive[]=[line(-30,-35,-30,35),line(-30,-35,35,0),line(35,0,-30,35),line(-60,-20,-30,-20),line(-60,20,-30,20),line(0,-60,0,-15)]
  if(differential)geometry.push(line(15,-15,60,-20),line(15,15,60,20));else geometry.push(line(35,0,60,0))
  const extras=roles.filter(role=>!['input-plus','input-minus','output','output-plus','output-minus','positive-supply'].includes(role))
  extras.forEach((role,index)=>{const x=(index-(extras.length-1)/2)*20;points[role]={x,y:60,label:({'negative-supply':'V−',ground:'GND',reference:'REF','gain-positive':'RG+','gain-negative':'RG−',enable:'EN',shutdown:'SHDN','shutdown-low':'nSHDN','output-common-mode':'VOCM'} as Record<string,string>)[role]??role};geometry.push(line(x,35,x,60))})
  return finish(model,roles,points,geometry,[{text:differential?'FDA':'INA',x:-20,y:4,size:8}])
}

export const additionalFunctionalFamilies:readonly FunctionalSymbolFamily[]=[
  {id:'series-voltage-reference',label:'串联电压基准',matches:isSeriesVoltageReference,roles:seriesReferenceRoles,draw:drawSeriesReference},
  {id:'fixed-shunt-reference',label:'固定并联电压基准',matches:(model,evidence)=>/^(?:LM(?:4040|4050|285|385)|REF1004)[A-Z0-9_.-]*(?:\/[A-Z0-9_-]+)?$/i.test(model.id)||/\b(?:fixed shunt|two[- ]terminal (?:voltage )?reference)\b/i.test(context(model,evidence)),roles:(model,evidence)=>{const roles=rolesFor(model,evidence);return exactRoles(roles,['anode','cathode'])?roles:undefined},draw:(model,roles,evidence)=>({...drawDiode(model,roles,{...evidence,ports:[...model.pins],comments:evidence?.comments??[],text:`fixed shunt zener reference\n${evidence?.text??''}`}),family:'fixed-shunt-reference'})},
  {id:'instrumentation-amplifier',label:'仪表放大器',matches:(model,evidence)=>/\binstrumentation amplifier\b/i.test(context(model,evidence))||/^INA(?:10[1-9]|11[0-9]|12[0-9]|128|129|163|217|326|327)[A-Z0-9_.-]*(?:\/[A-Z0-9_-]+)?$/i.test(model.id),roles:instrumentationRoles,draw:(model,roles)=>drawSpecialAmplifier(model,roles)},
  {id:'fully-differential-amplifier',label:'全差分放大器',matches:(model,evidence)=>/\bfully[- ]differential amplifier\b/i.test(context(model,evidence)),roles:(model,evidence)=>{const roles=rolesFor(model,evidence);return exactRoles(roles,['input-plus','input-minus','output-plus','output-minus','positive-supply'],['negative-supply','ground','output-common-mode','enable','shutdown','shutdown-low'])?roles:undefined},draw:(model,roles)=>drawSpecialAmplifier(model,roles,true)},
  {id:'comparator',label:'单/多通道比较器',matches:(model,evidence)=>/comparator|(?:^|\b)(?:LM(?:311|339|393|2901|2903)|LT1011|TLV(?:3501|3502|3701|3702))\b/i.test(context(model,evidence)),roles:amplifierRoles,draw:(model,roles)=>drawAmplifier(model,roles,true)},
  {id:'operational-amplifier',label:'单/多通道运算放大器',matches:(model,evidence)=>/operational amplifier|op[- ]?amp|(?:^|\b)(?:OPA\d+|OP\d+|TL0[678]\d|LM(?:358|324|741|1458)|NE553[24])\b/i.test(context(model,evidence)),roles:amplifierRoles,draw:(model,roles)=>drawAmplifier(model,roles)},
  {id:'discrete-bjt',label:'BJT 子电路',matches:model=>!!concreteType(model,/^(?:NPN|PNP)$/),roles:(model,evidence)=>{const roles=rolesFor(model,evidence);return exactRoles(roles,['collector','base','emitter'],['body'])?roles:undefined},draw:(model,roles)=>drawTransistor(model,roles,concreteType(model,/^(?:NPN|PNP)$/)!)},
  {id:'discrete-mosfet',label:'MOSFET 子电路',matches:model=>!!concreteType(model,/^(?:NMOS|PMOS)$/),roles:(model,evidence)=>{let roles=rolesFor(model,evidence);if(roles?.includes('base'))roles=roles.map(role=>role==='base'?'body':role);return exactRoles(roles,['drain','gate','source'],['body'])?roles:undefined},draw:(model,roles)=>drawTransistor(model,roles,concreteType(model,/^(?:NMOS|PMOS)$/)!)},
  {id:'discrete-jfet',label:'JFET 子电路',matches:model=>!!concreteType(model,/^(?:NJF|PJF)$/),roles:(model,evidence)=>{const roles=rolesFor(model,evidence);return exactRoles(roles,['drain','gate','source'])?roles:undefined},draw:(model,roles)=>drawTransistor(model,roles,concreteType(model,/^(?:NJF|PJF)$/)!)},
  {id:'diode-subcircuit',label:'二极管子电路',matches:(model,evidence)=>/\b(?:diode|schottky|rectifier|zener)\b/i.test(context(model,evidence))||/^\s*\.model\s+\S+\s+D\b/im.test(model.spice),roles:(model,evidence)=>{const roles=rolesFor(model,evidence);return exactRoles(roles,['anode','cathode'])?roles:undefined},draw:drawDiode},
  {id:'passive-subcircuit',label:'R / C / L 子电路',matches:(model,evidence)=>!!passiveType(model,evidence),roles:passiveRoles,draw:(model,roles,evidence)=>drawPassive(model,roles,passiveType(model,evidence)!)},
  {id:'voltage-regulator',label:'线性稳压器',matches:(model,evidence)=>/\b(?:linear regulator|voltage regulator|LDO)\b|(?:^|\b)(?:LM317|LM337|(?:LM|UA|L)7[89]\d\dC?)\b/i.test(context(model,evidence)),roles:regulatorRoles,draw:drawRegulator},
  {id:'phototransistor-optocoupler',label:'光电晶体管耦合器',matches:(model,evidence)=>/opto(?:coupler|isolator)|opto[- ]isolator|(?:^|\b)(?:4N\d\d|PC817|MOC8101|CNY17|TLP181)\b/i.test(context(model,evidence)),roles:optocouplerRoles,draw:drawOptocoupler},
  {id:'transformer',label:'双绕组变压器',matches:(model,evidence)=>/\b(?:transformer|xfmr|xform|trafo)\b/i.test(context(model,evidence)),roles:transformerRoles,draw:drawTransformer},
  {id:'voltage-controlled-switch',label:'电压控制开关',matches:(model,evidence)=>/voltage[- ]controlled switch|\b(?:switch|relay)\b/i.test(context(model,evidence))||/^\s*\.model\s+\S+\s+SW\b/im.test(model.spice),roles:switchRoles,draw:drawSwitch},
]
