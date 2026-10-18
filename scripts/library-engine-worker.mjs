import {parentPort} from 'node:worker_threads'
import {Simulation} from 'eecircuit-engine'
console.log=()=>{}
console.warn=()=>{}
const simulation=new Simulation()
await simulation.start()
parentPort.postMessage({ready:true,engine:simulation.getInitInfo().match(/ngspice-[\d.]+/)?.[0]??'ngspice'})
parentPort.on('message',async ({netlist})=>{
 try {
  simulation.setNetList(netlist)
  const result=await simulation.runSim()
  const log=simulation.getInfo(),errors=simulation.getError()
  parentPort.postMessage({points:result.numPoints,finite:result.data.every(vector=>vector.values.every(value=>typeof value==='number'?Number.isFinite(value):Number.isFinite(value?.real)&&Number.isFinite(value?.img))),log:log.slice(-18000),errors:errors.slice(-50)})
 } catch(error){parentPort.postMessage({exception:error.message,errors:simulation.getError(),log:simulation.getInfo().slice(-18000)})}
})
