import { Worker } from 'node:worker_threads'
import { readdirSync } from 'node:fs'
import type { Project } from '../src/core/circuit'
import type { Result } from '../src/core/results'

export function simulate(project:Project):Promise<Result> {
  const assets=new URL('../dist/assets/',import.meta.url)
  const bundle=readdirSync(assets).find(name=>/^engine\.worker-.*\.js$/.test(name))
  if(!bundle)throw new Error('Build the production worker first')
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{bundle:new URL(bundle,assets).href}})
    let settled=false
    const timer=setTimeout(()=>finish(new Error('Worker timed out')),30000)
    function finish(error?:Error,result?:Result){if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(result!)}
    worker.on('message',m=>{if(m.type==='ready')worker.postMessage(project);if(m.type==='result')finish(undefined,m.result);if(m.type==='error')finish(new Error(m.message))})
    worker.on('error',e=>finish(e instanceof Error?e:new Error(String(e))))
    worker.on('exit',code=>{if(!settled)finish(new Error(`Unexpected worker exit ${code}`))})
  })
}
