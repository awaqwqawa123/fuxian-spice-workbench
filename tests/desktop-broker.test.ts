import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
// @ts-ignore Pure transport modules are intentionally usable without a build step.
import { DesktopRouter } from '../scripts/desktop-broker/router.mjs'
// @ts-ignore See above.
import { runBroker, isPrimaryAppServerInvocation } from '../scripts/desktop-broker/broker.mjs'
import { DesktopControlClient } from '../scripts/desktop-broker/client.mjs'
import { circuitAgentTools } from '../src/core/agent-circuit'

function fixture() {
  const child:any[] = [], desktop:any[] = [], web:any[] = [], events:any[] = []
  const router = new DesktopRouter({ child:(m:any)=>child.push(m), desktop:(m:any)=>desktop.push(m), broadcast:(m:any)=>events.push(m), sendWeb:(client:any,m:any)=>web.push({...m, client}) })
  router.fromClient('desktop', {id:1,method:'initialize',params:{}})
  router.fromChild({id:child.at(-1).id,result:{}})
  router.fromClient('desktop', {id:2,method:'thread/resume',params:{threadId:'thread-1'}})
  router.fromChild({id:child.at(-1).id,result:{thread:{id:'thread-1',status:{type:'idle'}}}})
  return {router,child,desktop,web,events}
}
test('multiplexes colliding request IDs and broadcasts real notifications',()=>{
  const f=fixture()
  f.router.fromClient('desktop',{id:1,method:'thread/read',params:{threadId:'thread-1'}})
  const a=f.child.at(-1).id
  f.router.fromClient('web',{id:1,method:'thread/read',params:{threadId:'thread-1'}},'client')
  const b=f.child.at(-1).id
  assert.notEqual(a,b)
  f.router.fromChild({id:b,result:{marker:'web'}}); f.router.fromChild({id:a,result:{marker:'desktop'}})
  assert.equal(f.web.at(-1).result.marker,'web'); assert.equal(f.desktop.at(-1).result.marker,'desktop')
  f.router.fromChild({method:'item/agentMessage/delta',params:{threadId:'thread-1',delta:'hello'}})
  assert.equal(f.events.at(-1).type,'notification')
})
test('idle ownership handoff rejects other wrong-side writes and unsubscribe but preserves reads',()=>{
  const f=fixture(); assert.equal(f.router.handoff('thread-1','web').owner,'web')
  const count=f.child.length
  for(const method of ['turn/interrupt','thread/unsubscribe','thread/rollback']) f.router.fromClient('desktop',{id:4,method,params:{threadId:'thread-1'}})
  assert.equal(f.child.length,count)
  f.router.fromClient('desktop',{id:5,method:'thread/read',params:{threadId:'thread-1'}})
  assert.equal(f.child.length,count+1)
  f.router.fromClient('desktop',{id:6,method:'thread/resume',params:{threadId:'thread-1',excludeTurns:true}})
  assert.equal(f.child.length,count+2)
  assert.throws(()=>f.router.handoff('unloaded','web'),/打开/)
})

test('desktop sends automatically take an idle web-owned thread and deduplicate request retries',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  const message={id:50,method:'turn/start',params:{threadId:'thread-1',input:[{type:'text',text:'从桌面继续'}]}}
  const before=f.child.length
  f.router.fromClient('desktop',message)
  assert.equal(f.child.length,before+1)
  assert.equal(f.router.state('thread-1').owner,'desktop')
  assert.equal(f.router.state('thread-1').busy,true)
  assert.deepEqual(f.child.at(-1).params,message.params)
  f.router.fromClient('desktop',message)
  assert.equal(f.child.length,before+1,'an in-flight duplicate does not start another turn')
  f.router.fromChild({id:f.child.at(-1).id,result:{turn:{id:'desktop-turn'}}})
  f.router.fromClient('desktop',message)
  assert.equal(f.child.length,before+1,'an acknowledged duplicate replays the receipt only')
  assert.deepEqual(f.desktop.at(-1),{id:50,result:{turn:{id:'desktop-turn'}}})
})

test('desktop send waits behind the web turn, approvals and tools before forwarding once',()=>{
  const f=fixture(); f.router.handoff('thread-1','web'); f.router.registerTools('handler','thread-1',['inspect_circuit'])
  f.router.fromClient('web',{id:60,method:'turn/start',params:{threadId:'thread-1'}},'client')
  f.router.fromChild({id:'web-approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread-1'}})
  f.router.fromChild({id:'web-tool',method:'item/tool/call',params:{threadId:'thread-1',tool:'inspect_circuit'}})
  const before=f.child.length, message={id:61,method:'turn/start',params:{threadId:'thread-1',input:[{type:'text',text:'等前一轮完成再处理'}]}}
  f.router.fromClient('desktop',message); f.router.fromClient('desktop',message)
  assert.equal(f.child.length,before)
  assert.equal(f.router.state('thread-1').owner,'web')
  assert.equal(f.router.state('thread-1').pendingOwner,'desktop')
  assert.equal(f.router.respond('desktop','web-approval',{result:{decision:'accept'}}),false)
  f.router.fromChild({method:'thread/status/changed',params:{threadId:'thread-1',status:{type:'idle'}}})
  assert.equal(f.child.length,before,'idle status cannot bypass outstanding approval or tool')
  assert.equal(f.router.respond('web','web-approval',{result:{decision:'decline'}},'client'),true)
  assert.equal(f.router.state('thread-1').owner,'web')
  assert.equal(f.router.respond('web','web-tool',{result:{success:true}},'handler'),true)
  assert.equal(f.router.state('thread-1').owner,'desktop')
  assert.equal(f.child.filter((message:any)=>message.method==='turn/start').length,2)
  assert.deepEqual(f.child.at(-1).params,message.params)
  f.router.settle('thread-1')
  assert.equal(f.child.filter((message:any)=>message.method==='turn/start').length,2)
})

test('manual ownership changes cancel queued desktop input and never send it late',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:70,method:'turn/start',params:{threadId:'thread-1'}},'client')
  f.router.fromClient('desktop',{id:71,method:'turn/start',params:{threadId:'thread-1',input:[{type:'text',text:'取消这条'}]}})
  assert.equal(f.router.state('thread-1').pendingOwner,'desktop')
  f.router.handoff('thread-1','web')
  assert.equal(f.desktop.at(-1).id,71); assert.match(f.desktop.at(-1).error.message,/手动切换/)
  f.router.fromChild({method:'turn/completed',params:{threadId:'thread-1'}})
  assert.equal(f.router.state('thread-1').owner,'web')
  assert.equal(f.child.filter((message:any)=>message.method==='turn/start').length,1)
})

test('late web reads and old start errors cannot clear the automatically started desktop turn',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:72,method:'turn/start',params:{threadId:'thread-1'}},'client')
  const oldStart=f.child.at(-1).id
  f.router.fromClient('web',{id:73,method:'thread/read',params:{threadId:'thread-1'}},'client')
  const oldRead=f.child.at(-1).id
  f.router.fromClient('desktop',{id:74,method:'turn/start',params:{threadId:'thread-1',input:[{type:'text',text:'桌面下一轮'}]}})
  f.router.fromChild({method:'turn/completed',params:{threadId:'thread-1'}})
  const desktopStart=f.child.at(-1).id
  assert.equal(f.router.state('thread-1').owner,'desktop');assert.equal(f.router.state('thread-1').busy,true)
  f.router.fromChild({id:oldRead,result:{thread:{id:'thread-1',status:{type:'idle'}}}})
  f.router.fromChild({id:oldStart,error:{code:409,message:'delayed old rejection'}})
  assert.equal(f.router.state('thread-1').busy,true)
  f.router.fromChild({id:desktopStart,result:{turn:{id:'desktop-next'}}})
  assert.equal(f.desktop.at(-1).id,74)
  assert.equal(f.router.state('thread-1').busy,true)
})

test('one queued message per thread and global queue bound preserve the earlier desktop request',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:80,method:'turn/start',params:{threadId:'thread-1'}},'client')
  f.router.fromClient('desktop',{id:81,method:'turn/start',params:{threadId:'thread-1',input:[{type:'text',text:'保留第一条'}]}})
  f.router.fromClient('desktop',{id:82,method:'turn/start',params:{threadId:'thread-1',input:[{type:'text',text:'第二条'}]}})
  assert.equal(f.desktop.at(-1).id,82); assert.match(f.desktop.at(-1).error.message,/已有一条/)
  for(let index=2;index<=9;index++){
    const id=`thread-${index}`,thread=f.router.track(id,'web');thread.loaded=true;thread.busy=true
    f.router.fromClient('desktop',{id:90+index,method:'turn/start',params:{threadId:id}})
  }
  assert.equal(f.router.queuedDesktopTurns.size,8)
  assert.equal(f.desktop.at(-1).id,99); assert.match(f.desktop.at(-1).error.message,/会话过多/)
  f.router.fromChild({method:'turn/completed',params:{threadId:'thread-1'}})
  assert.equal(f.child.at(-1).params.input[0].text,'保留第一条')
})

test('unload and desktop disconnect cancel queued turns without restarting or replaying',()=>{
  for(const exit of ['unload','disconnect']){
    const f=fixture();f.router.handoff('thread-1','web')
    f.router.fromClient('web',{id:110,method:'turn/start',params:{threadId:'thread-1'}},'client')
    const message={id:111,method:'turn/start',params:{threadId:'thread-1'}}
    f.router.fromClient('desktop',message)
    if(exit==='unload')f.router.fromChild({method:'thread/status/changed',params:{threadId:'thread-1',status:{type:'notLoaded'}}})
    else f.router.desktopConnected=false
    assert.equal(f.router.queuedDesktopTurns.size,0)
    assert.ok(f.desktop.find((reply:any)=>reply.id===111&&reply.error))
    f.router.desktopConnected=true;f.router.track('thread-1').loaded=true
    f.router.fromChild({method:'turn/completed',params:{threadId:'thread-1'}})
    f.router.fromClient('desktop',message)
    assert.equal(f.child.filter((request:any)=>request.method==='turn/start').length,1)
  }
})

test('web can update a project chat title while desktop owns the conversation',()=>{
  const f=fixture(), before=f.child.length
  f.router.fromClient('web',{id:21,method:'thread/name/set',params:{threadId:'thread-1',name:'电路：RC 低通'}},'client')
  assert.equal(f.child.length,before+1)
  assert.equal(f.child.at(-1).method,'thread/name/set')
  f.router.fromChild({id:f.child.at(-1).id,result:{}})
  assert.deepEqual(f.web.at(-1).result,{})
  f.router.fromClient('web',{id:22,method:'thread/rollback',params:{threadId:'thread-1'}},'client')
  assert.equal(f.child.length,before+1,'other writes still require desktop ownership')
})
test('busy handoff waits for completion and errors release start reservation',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:7,method:'turn/start',params:{threadId:'thread-1'}},'client')
  assert.equal(f.router.handoff('thread-1','desktop').pendingOwner,'desktop')
  assert.equal(f.router.state('thread-1').owner,'web')
  f.router.fromChild({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn1'}}})
  assert.equal(f.router.state('thread-1').owner,'desktop')
  f.router.fromClient('desktop',{id:8,method:'turn/start',params:{threadId:'thread-1'}})
  f.router.fromChild({id:f.child.at(-1).id,error:{code:403,message:'unavailable'}})
  assert.equal(f.router.state('thread-1').busy,false)
})
test('native reads repair missed turn completion and unload without overriding newer activity',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:30,method:'turn/start',params:{threadId:'thread-1'}},'client')
  assert.equal(f.router.state('thread-1').busy,true)
  assert.equal(f.router.handoff('thread-1','desktop').pendingOwner,'desktop')
  f.router.fromClient('web',{id:31,method:'thread/read',params:{threadId:'thread-1'}},'client')
  f.router.fromChild({id:f.child.at(-1).id,result:{thread:{id:'thread-1',status:{type:'idle'}}}})
  assert.equal(f.router.state('thread-1').busy,false)
  assert.equal(f.router.state('thread-1').owner,'desktop')

  f.router.fromClient('desktop',{id:32,method:'thread/read',params:{threadId:'thread-1'}})
  const staleRead=f.child.at(-1).id
  f.router.fromClient('desktop',{id:33,method:'turn/start',params:{threadId:'thread-1'}})
  f.router.fromChild({id:staleRead,result:{thread:{id:'thread-1',status:{type:'idle'}}}})
  assert.equal(f.router.state('thread-1').busy,true,'a read launched before the turn cannot clear it')
  f.router.fromClient('web',{id:34,method:'thread/read',params:{threadId:'thread-1'}},'client')
  f.router.fromChild({id:f.child.at(-1).id,result:{thread:{id:'thread-1',status:{type:'notLoaded'}}}})
  assert.equal(f.router.state('thread-1').busy,false)
  assert.equal(f.router.state('thread-1').loaded,false)
  assert.throws(()=>f.router.handoff('thread-1','web'),/打开/)
})
test('a delayed failure from an old turn cannot clear a newer active turn',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:40,method:'turn/start',params:{threadId:'thread-1'}},'client')
  const oldStart=f.child.at(-1).id
  f.router.fromClient('web',{id:41,method:'thread/read',params:{threadId:'thread-1'}},'client')
  f.router.fromChild({id:f.child.at(-1).id,result:{thread:{id:'thread-1',status:{type:'idle'}}}})
  f.router.fromClient('web',{id:42,method:'turn/start',params:{threadId:'thread-1'}},'client')
  assert.equal(f.router.state('thread-1').busy,true)
  f.router.fromChild({id:oldStart,error:{code:-32600,message:'old request rejected'}})
  assert.equal(f.router.state('thread-1').busy,true)
})
test('new web thread stays web-owned when started event precedes response',()=>{
  const f=fixture()
  f.router.fromClient('web',{id:12,method:'thread/start',params:{}},'client')
  const id=f.child.at(-1).id
  f.router.fromChild({method:'thread/started',params:{thread:{id:'new'}}})
  f.router.fromChild({id,result:{thread:{id:'new',status:{type:'idle'}}}})
  assert.equal(f.router.state('new').owner,'web')
})
test('approval can be answered only by initiating side; reconnect replays pending',()=>{
  const f=fixture(); f.router.handoff('thread-1','web')
  f.router.fromClient('web',{id:13,method:'turn/start',params:{threadId:'thread-1'}},'a')
  const request={id:'approve-1',method:'item/commandExecution/requestApproval',params:{threadId:'thread-1'}}
  f.router.fromChild(request)
  assert.equal(f.router.pendingForWeb()[0].message.id,request.id)
  assert.equal(f.router.respond('desktop',request.id,{result:{decision:'accept'}}),false)
  assert.equal(f.router.respond('web',request.id,{result:{decision:'decline'}},'b'),true)
  assert.equal(f.router.pendingForWeb().length,0)
  assert.equal(f.router.respond('web',request.id,{result:{decision:'accept'}},'b'),false)
})
test('unknown tools stay on desktop and registered circuit tools use only handler',()=>{
  const f=fixture(); f.router.handoff('thread-1','web'); f.router.registerTools('handler','thread-1',['inspect_circuit'])
  const size=f.desktop.length
  f.router.fromChild({id:31,method:'item/tool/call',params:{threadId:'thread-1',tool:'inspect_circuit'}})
  assert.equal(f.desktop.length,size); assert.equal(f.web.at(-1).client,'handler')
  const deliveries=f.web.length
  f.router.registerTools('handler','thread-1',['inspect_circuit'])
  assert.equal(f.web.length,deliveries, 'Polling must not replay an in-flight tool to its current handler')
  assert.equal(f.router.respond('desktop',31,{result:{success:true}}),false)
  assert.equal(f.router.respond('web',31,{result:{success:true}},'other'),false)
  f.router.detach('handler'); f.router.registerTools('new-handler','thread-1',['inspect_circuit'])
  assert.equal(f.web.at(-1).message.id,31)
  assert.equal(f.router.respond('web',31,{result:{success:true}},'new-handler'),true)
  f.router.fromChild({id:32,method:'item/tool/call',params:{threadId:'thread-1',tool:'desktop_host_tool'}})
  assert.equal(f.desktop.at(-1).id,32)
  f.router.detach('new-handler')
  f.router.fromChild({id:33,method:'item/tool/call',params:{threadId:'thread-1',tool:'inspect_circuit'}})
  assert.equal(f.child.at(-1).result.success,false)
})
test('all current circuit callbacks register without pretending to update native tool schemas',()=>{
  const f=fixture(),before=f.child.length,names=[...new Set([...circuitAgentTools.map(tool=>tool.name),'set_measurement_probes'])]
  f.router.registerTools('handler','thread-1',names)
  assert.equal(f.child.length,before,'registering callbacks must not issue resume/start or a schema update')
  const desktopBefore=f.desktop.length
  f.router.fromChild({id:35,method:'item/tool/call',params:{threadId:'thread-1',tool:'set_measurement_probes',arguments:{probes:[]}}})
  assert.equal(f.desktop.length,desktopBefore)
  assert.equal(f.web.at(-1).client,'handler')
  assert.equal(f.web.at(-1).message.params.tool,'set_measurement_probes')
  assert.throws(()=>f.router.registerTools('handler','thread-1',[...names,'exec_command']),/已知电路工具/)
})
test('recognizes only primary stdio app-server startup',()=>{
  assert.equal(isPrimaryAppServerInvocation(['app-server','--analytics-default-enabled']),true)
  assert.equal(isPrimaryAppServerInvocation(['app-server','--listen','stdio://']),true)
  for(const args of [['--version'],['app-server','--help'],['app-server','generate-json-schema'],['app-server','--listen','ws://localhost:1234']]) assert.equal(isPrimaryAppServerInvocation(args),false)
})
test('real named pipe authenticates, shares one child and does not restart on disconnect',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop-broker-test-'))
  const discoveryPath=join(directory,'discovery.json'), fake=join(directory,'fake.mjs')
  await writeFile(fake,`import readline from 'node:readline';let writes=0;readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='thread/start'){writes++;return}if(m.method==='thread/read'&&m.params.threadId==='hang')return;const result=m.method==='initialize'?{}:m.method==='thread/resume'?{thread:{id:m.params.threadId,status:{type:'idle'}}}:m.method==='model/list'?{writes}:{pid:process.pid};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')})`)
  const input=new PassThrough(), output=new PassThrough(), errors=new PassThrough()
  const runtime=await runBroker({executable:process.execPath,args:[fake],directory,discoveryPath,input,output,errors})
  const client=new DesktopControlClient({discoveryPath,timeoutMs:1500})
  try {
    const initialized=new Promise<void>(resolve=>output.once('data',()=>resolve()))
    input.write(JSON.stringify({id:1,method:'initialize',params:{}})+'\n'); await initialized
    await client.connect()
    assert.equal((await client.status()).ready,true)
    const first=await client.call('thread/read',{threadId:'thread-1'})
    client.close(); await client.connect()
    assert.equal((await client.call('thread/read',{threadId:'thread-1'})).pid,first.pid)
    const timedOut=new DesktopControlClient({discoveryPath,timeoutMs:100})
    await timedOut.connect()
    const uncertainWrite=timedOut.call('thread/start',{})
    await new Promise(resolve=>setTimeout(resolve,20))
    const otherPending=timedOut.call('thread/read',{threadId:'hang'}).catch(error=>error)
    await assert.rejects(uncertainWrite,/等待超时/)
    assert.match((await otherPending).message,/连接已关闭/)
    assert.equal((timedOut as unknown as {pending:Map<unknown,unknown>}).pending.size,0,'all pending requests must settle when the pipe is discarded')
    assert.equal(timedOut.connected,false,'a timed-out pipe must be discarded')
    await timedOut.connect()
    assert.equal((await timedOut.status()).ready,true,'a fresh pipe can recover without restarting the desktop')
    assert.equal((await timedOut.call('model/list')).writes,1,'reconnecting never replays an uncertain thread/start')
    timedOut.close()
    const second=await runBroker({executable:process.execPath,args:[fake],directory,discoveryPath,input:new PassThrough(),output:new PassThrough(),errors:new PassThrough()}).then(()=>true,()=>false)
    assert.equal(second,false)
    const wrongPath=join(directory,'wrong.json'), discovery=JSON.parse(await readFile(discoveryPath,'utf8'))
    await writeFile(wrongPath,JSON.stringify({...discovery,token:'0'.repeat(64)}))
    const bad=new DesktopControlClient({discoveryPath:wrongPath,timeoutMs:1500})
    await assert.rejects(bad.connect()); bad.close()
  } finally { client.close(); await runtime.close(); input.destroy(); output.destroy(); errors.destroy(); await rm(directory,{recursive:true,force:true,maxRetries:3}) }
})

test('real named pipe auto-handoff preserves desktop input across a web reconnect and sends once after completion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desktop-auto-handoff-test-'))
  const discoveryPath=join(directory,'discovery.json'),fake=join(directory,'fake.mjs')
  await writeFile(fake,String.raw`import readline from 'node:readline';
    let writes=0; const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(m.id===undefined)return;
      if(m.method==='turn/start'){writes++;send({id:m.id,result:{turn:{id:'turn-'+writes,input:m.params.input}}});return;}
      if(m.method==='model/list'&&m.params.complete)send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-'+writes}}});
      const result=m.method==='initialize'?{}:m.method==='thread/resume'?{thread:{id:m.params.threadId,status:{type:'idle'}}}:{writes,pid:process.pid};send({id:m.id,result});
    });`)
  const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough(),messages:any[]=[],waiters=new Map<number,(message:any)=>void>()
  let buffered=''
  output.on('data',chunk=>{
    buffered+=chunk.toString()
    for(let newline=buffered.indexOf('\n');newline>=0;newline=buffered.indexOf('\n')){
      const message=JSON.parse(buffered.slice(0,newline));buffered=buffered.slice(newline+1);messages.push(message)
      const waiter=waiters.get(message.id);if(waiter){waiters.delete(message.id);waiter(message)}
    }
  })
  const desktopCall=(id:number,method:string,params:any)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(id);reject(new Error(`Desktop response timed out: ${id}`))},2000)
    waiters.set(id,message=>{clearTimeout(timer);resolve(message)})
    input.write(JSON.stringify({id,method,params})+'\n')
  })
  const runtime=await runBroker({executable:process.execPath,args:[fake],directory,discoveryPath,input,output,errors})
  const client=new DesktopControlClient({discoveryPath,timeoutMs:1500})
  try{
    await desktopCall(1,'initialize',{});await desktopCall(2,'thread/resume',{threadId:'thread-1'});await client.connect()
    const pid=(await client.call('model/list')).pid
    await client.handoff('thread-1','web')
    const idle=await desktopCall(3,'turn/start',{threadId:'thread-1',input:[{type:'text',text:'空闲自动接管'}]})
    assert.equal(idle.result.turn.input[0].text,'空闲自动接管')
    assert.equal((await client.status('thread-1')).owner,'desktop')
    await client.call('model/list',{complete:true});await client.handoff('thread-1','web')
    await client.call('turn/start',{threadId:'thread-1',input:[{type:'text',text:'网页任务'}]})
    const params={threadId:'thread-1',input:[{type:'text',text:'保留桌面完整消息'}]}
    const queued=desktopCall(4,'turn/start',params)
    // The stdio and named-pipe streams are independent. Poll until the request is
    // observed rather than relying on a fixed transport scheduling delay.
    for(let attempt=0;attempt<50&&(await client.status('thread-1')).pendingOwner!=='desktop';attempt++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal((await client.status('thread-1')).pendingOwner,'desktop')
    assert.equal(messages.some(message=>message.id===4),false,'queued JSON-RPC call remains pending')
    input.write(JSON.stringify({id:4,method:'turn/start',params})+'\n')
    client.close();await client.connect()
    assert.equal((await client.status('thread-1')).pendingOwner,'desktop','web transport disconnect does not lose desktop input')
    await client.call('model/list',{complete:true})
    assert.equal((await queued).result.turn.input[0].text,'保留桌面完整消息')
    assert.equal((await client.call('model/list')).writes,3)
    const duplicate=await desktopCall(4,'turn/start',params)
    assert.equal(duplicate.result.turn.id,'turn-3')
    assert.equal((await client.call('model/list')).writes,3,'duplicate request replays only the completed response')
    assert.equal((await client.call('model/list')).pid,pid,'handoff uses the same official child')
    await client.call('model/list',{complete:true});await client.handoff('thread-1','web')
    await client.call('turn/start',{threadId:'thread-1'})
    const cancelled=desktopCall(5,'turn/start',{threadId:'thread-1',input:[{type:'text',text:'手动切换后不可迟发'}]})
    for(let attempt=0;attempt<50&&(await client.status('thread-1')).pendingOwner!=='desktop';attempt++)await new Promise(resolve=>setTimeout(resolve,10))
    await client.handoff('thread-1','web')
    assert.match((await cancelled).error.message,/手动切换/)
    await client.call('model/list',{complete:true})
    assert.equal((await client.call('model/list')).writes,4)
  }finally{
    client.close();await runtime.close();input.destroy();output.destroy();errors.destroy();await rm(directory,{recursive:true,force:true,maxRetries:3})
  }
})
