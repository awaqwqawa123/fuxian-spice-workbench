import { Worker } from 'node:worker_threads'
import { readdir } from 'node:fs/promises'
import type { Project } from '../src/core/circuit'
import type { Result } from '../src/core/results'

export async function simulateAgentCircuit(project:Project,signal:AbortSignal):Promise<Result>{
  if(signal.aborted)throw new Error('任务已停止')
  const assets=new URL('../dist/assets/',import.meta.url)
  const bundle=await readdir(assets).then(files=>files.find(name=>/^engine\.worker-.*\.js$/.test(name))).catch(()=>undefined)
  if(!bundle)throw new Error('Agent 仿真需要构建后的求解器，请先运行 npm run build')
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./agent-worker.mjs',import.meta.url),{workerData:{bundle:new URL(bundle,assets).href}})
    let settled=false
    const timeout=Math.min(180000,30000*(project.sweep?.values.length??1))
    const timer=setTimeout(()=>finish(new Error(`ngspice 求解超过 ${timeout/1000} 秒，已停止`)),timeout)
    const abort=()=>finish(new Error('任务已停止'))
    function finish(error?:Error,result?:Result){
      if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result!)
    }
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    worker.on('message',message=>{if(settled)return;if(message.type==='ready')worker.postMessage(project);if(message.type==='result')finish(undefined,message.result);if(message.type==='error')finish(new Error(message.message))})
    worker.on('error',error=>finish(error instanceof Error?error:new Error(String(error))));worker.on('exit',code=>{if(!settled)finish(new Error(`ngspice 线程意外退出 ${code}`))})
  })
}
