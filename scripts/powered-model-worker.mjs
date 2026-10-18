import {parentPort} from 'node:worker_threads'
import {Simulation} from 'eecircuit-engine'
console.log=()=>{}
console.warn=()=>{}
const simulation=new Simulation()
await simulation.start()
parentPort.postMessage({ready:true,engine:simulation.getInitInfo().match(/ngspice-[\d.]+/)?.[0]??'ngspice'})
parentPort.on('message',async({netlist})=>{
 try{
  simulation.setNetList(netlist)
  const result=await simulation.runSim()
  parentPort.postMessage({points:result.numPoints,vectors:result.data.map(vector=>({name:vector.name,values:vector.values.slice(0,10000)})),errors:simulation.getError().slice(-50),log:simulation.getInfo().slice(-18000)})
 }catch(error){parentPort.postMessage({exception:error.message,errors:simulation.getError().slice(-50),log:simulation.getInfo().slice(-18000)})}
})
