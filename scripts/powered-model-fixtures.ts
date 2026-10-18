import {prepareRuntimeNetlist} from '../src/core/spice-runtime-compatibility'
import {functionalPinEvidenceForModel,namedFunctionalPinRole} from '../src/core/model-pin-evidence'
import {importedModelNetlist,type ImportedSpiceModel} from '../src/core/spice-models'
import {thermalModelStart} from '../src/core/model-thermal-start'
export interface PoweredFixture {family:string;evidence:string[];conditions:string;netlist:string;observable:string;solverHints:string[];expectedResistance?:number;expectedDc?:number;inputAc?:number}
export interface FixtureDecision {fixture?:PoweredFixture;reason?:string}
const normalize=(text:string)=>text.toUpperCase().replace(/−/g,'-').replace(/\\/g,'').trim()
/** Explicit functional labels only; never infer numerical package-pin order. */
export function poweredTerminalRoles(model:ImportedSpiceModel):{roles:string[];evidence:string[]} | undefined {
 const known=functionalPinEvidenceForModel(model)
 if(known?.roles)return {roles:known.roles,evidence:[known.text||'Named original ordered subcircuit terminals']}
 const pins=model.symbol?.origin==='imported'?model.symbol.pins:undefined
 if(!pins||pins.length!==model.pins.length||pins.some((pin,index)=>pin.index!==index))return
 const labels=pins.map(pin=>normalize(pin.label))
 const amplifier=labels.includes('OUT')&&labels.includes('V+')&&labels.includes('V-')&&labels.includes('+')&&labels.includes('-')
 const roles=labels.map(label=>amplifier&&label==='+'?'input-plus':amplifier&&label==='-'?'input-minus':namedFunctionalPinRole(label))
 if(!roles.every(Boolean))return
 return {roles:roles as string[],evidence:[`Original imported symbol ${model.symbol!.source?.label}; ordered labels ${labels.join(', ')}`]}
}
/** Vishay's documented RP/RN resistor interface and explicit thermal equation.
 * Derive the solver start from source coefficients; retain all source bytes. */
function thermistorFixture(model:ImportedSpiceModel,analysis:'op'|'ac'|'tran'):FixtureDecision | undefined {
 const start=thermalModelStart(model)
 if(!start)return
 const nodes=model.pins.map(pin=>normalize(pin)==='RP'?'OBS':'0')
 const lines=['Documented Vishay thermal resistor low-voltage fixture',`VTEST OBS 0 DC .01 AC .001`,`XDUT ${nodes.join(' ')} ${model.id}`,importedModelNetlist(model),'.temp 27',`.nodeset ${start.nodes.map(node=>`V(xdut.${node.path})=${node.value}`).join(' ')}`,'.options itl1=100 gmin=1e-10',analysis==='op'?'.op':analysis==='ac'?'.ac dec 6 10 10k':'.tran 1u 50u','.save V(OBS) I(VTEST)','.end']
 return {fixture:{family:start.family==='ptc'?'ptc-thermistor':'thermistor',evidence:start.evidence,conditions:'27 °C; 10 mV across RP/RN; AC 1 mV, 10 Hz–10 kHz when requested',netlist:prepareRuntimeNetlist(lines.join('\n')),observable:'i(vtest)',solverHints:[`.nodeset ${start.nodes.map(node=>`V(xdut.${node.path})=${node.value}`).join(' ')}; source unchanged`],expectedResistance:start.resistance}}
}
export function poweredModelFixture(model:ImportedSpiceModel,analysis:'op'|'ac'|'tran'='op'):FixtureDecision {
 if(model.kind!=='X')return {reason:'Only subcircuits require these powered fixtures'}
 const thermal=thermistorFixture(model,analysis);if(thermal)return thermal
 const terminals=poweredTerminalRoles(model)
 if(!terminals)return {reason:'Ordered terminal roles are incomplete; numerical pin order never supplies function evidence'}
 const roles=terminals.roles,nodes=roles.map((_,index)=>`P${index}`),at=(role:string)=>nodes[roles.indexOf(role)]
 const has=(role:string)=>roles.includes(role)
 const lines=['Documented ordered-port powered compatibility fixture']
 let family='',conditions='',observable=''
 if(roles.length===5&&has('input-plus')&&has('input-minus')&&has('output')&&has('positive-supply')&&has('negative-supply')){
  family=/comparator/i.test([model.deviceInfo?.function,model.deviceInfo?.description,model.symbol?.family].join(' '))?'comparator':'amplifier'
  if(family==='amplifier'&&!/op[- ]?amp|operational[- ]amplifier/i.test([model.deviceInfo?.function,model.deviceInfo?.description,model.symbol?.family,...model.deviceInfo?.evidence.map(e=>e.text)??[]].join(' '))&&!model.symbol?.pins.some(p=>p.label==='+'))return {reason:'Amplifier terminal interface known but function not positively identified'}
  const upper=at('positive-supply'),lower=at('negative-supply'),output=at('output'),plus=at('input-plus'),minus=at('input-minus')
  lines.push(`VCC ${upper} 0 5`,`VEE ${lower} 0 -5`,`VIN ${plus} 0 DC .01 AC .001`)
  if(family==='amplifier')lines.push(`RFB ${output} ${minus} 1k`)
  else lines.push(`VMIN ${minus} 0 0`,`RPULL ${upper} ${output} 10k`)
  lines.push(`RLOAD ${output} 0 10k`);conditions=`±5 V rails; ${family==='amplifier'?'unity feedback':'10 mV differential and 10 kohm pullup'}; 10 kohm output load; AC input 1 mV`
  observable=`v(${output.toLowerCase()})`
 }else if(roles.length===2&&has('anode')&&has('cathode')){
  family='diode';lines.push('VBIAS SUPPLY 0 .1',`RLIMIT SUPPLY ${at('anode')} 10k`,`VGND ${at('cathode')} 0 0`);conditions='100 mV forward voltage via 10 kohm current limiting';observable=`v(${at('anode').toLowerCase()})`
 }else return {reason:`Known roles ${roles.join(', ')} need a specialized fixture (control mode, compensation, supply range or timing not established)`}
 lines.push(`XDUT ${nodes.join(' ')} ${model.id}`,importedModelNetlist(model),'.options itl1=100 gmin=1e-10',analysis==='op'?'.op':analysis==='ac'?'.ac dec 6 10 10k':'.tran 1u 50u',`.save ${observable}`,' .end')
 return {fixture:{family,evidence:terminals.evidence,conditions,netlist:prepareRuntimeNetlist(lines.join('\n')),observable,solverHints:[],...(family==='amplifier'?{expectedDc:.01,inputAc:.001}:{})}}
}
