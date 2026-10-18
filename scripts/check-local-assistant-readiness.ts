import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { createCursorMiddleware } from '../server/cursor-middleware'
import { closeAssistantConnectionSettings } from '../server/assistant-connections'
import { findCursorExecutable } from '../server/cursor-runtime'
import { resolveCursorLaunch } from '../server/cursor-launch'
import { CursorRpc } from '../server/cursor-rpc'
const server=createServer((req,res)=>{void createMiddleware(req,res,()=>{res.writeHead(404);res.end()})}),createMiddleware=createCursorMiddleware()
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const address=server.address();assert.ok(address&&typeof address==='object')
const origin='http://127.0.0.1:'+address.port
const results:unknown[]=[]
try{
  for(const engine of ['codex','cursor','dsh']){
    const response=await fetch(origin+'/api/assistant-connections',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Fuxian-Assistant-Connection':'1'},body:JSON.stringify({engine,action:'connect'})})
    assert.equal(response.status,200)
    const result=await response.json();results.push({engine,state:result.state,version:result.native?.version??result.dsh?.version,authenticated:result.native?.authenticated??null,message:result.message})
  }
  const executable=await findCursorExecutable();assert.ok(executable)
  const launch=await resolveCursorLaunch(executable)
  const rpc=new CursorRpc(launch.executable,[...launch.argsPrefix,'--sandbox','enabled','acp'],{cwd:process.cwd(),env:process.env,signal:AbortSignal.timeout(15000),timeoutMs:15000})
  try{
    const initialized=await rpc.call('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'fuxian-readiness-probe',version:'1'}})
    assert.equal(initialized.protocolVersion,1);assert.equal(initialized.agentCapabilities.mcpCapabilities.http,true);assert.equal(initialized.agentCapabilities.loadSession,true)
    results.push({engine:'cursor',actualVendorInitialize:true,capabilities:initialized.agentCapabilities})
  }finally{await rpc.close()}
  const response=await fetch(origin+'/api/assistant-connections',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Fuxian-Assistant-Connection':'1'},body:JSON.stringify({engine:'dsh',action:'configure'})})
  assert.equal(response.status,200);const configuration=await response.json();assert.match(configuration.url,/^http:\/\/127\.0\.0\.1:/)
  results.push({engine:'dsh',officialSettingsStarted:true})
  await mkdir('verification', { recursive: true }); await writeFile('verification/assistant-native-readiness.json',JSON.stringify({date:'2026-10-12',noModelPromptSent:true,results},null,2));console.log(JSON.stringify(results))
}finally{await closeAssistantConnectionSettings();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
