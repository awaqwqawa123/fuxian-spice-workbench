import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
async function fixture() {
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3032/'})
  dom.window.open = () => null
  const saved=new Map<string,PropertyDescriptor|undefined>(), operations:{engine:string;action:string}[]=[]
  let cursorReady=false, stall=false, dshReady=false
  const cursor=()=>({installed:true,available:cursorReady,authenticated:cursorReady,version:'2026.10.01-e373342',model:null,message:cursorReady?'真实协议就绪':'官方 CLI 未登录'})
  const dsh=()=>({installed:true,available:dshReady,version:'fixture-sdk',message:dshReady?'已配置，待任务核对凭据':'未配置',providers:[{id:'deepseek-official',label:'DeepSeek',configured:dshReady,auth:dshReady?'api-key':'none',models:['example-model']}]})
  const fetchFixture=(async(input:string,init?:RequestInit)=>{
    if(input==='/api/codex/status')return Response.json({installed:true,available:true,authenticated:null,version:'fixture-codex',model:'example',message:'本地协议就绪'})
    if(input==='/api/codex/installation')return Response.json({configuredPath:null,effectivePath:null,source:'automatic',available:false,message:'未指定路径'})
    if(input==='/api/cursor/status')return Response.json(cursor())
    if(input==='/api/dsh-local/status')return Response.json(dsh())
    if(input==='/api/desktop-control/setup')return Response.json({stage:'unprepared'})
    if(input==='/api/desktop-control/conversation-folder')return Response.json({directory:null,defaultDirectory:'C:\\workbench'})
    if(input.startsWith('/api/desktop-control/state?'))return Response.json({projectId:'project-a',threadId:null,connected:false,ready:false,desktopConnected:false,messages:[],approvals:[]})
    if(input==='/api/assistant-connections'){
      const request=JSON.parse(String(init?.body));operations.push(request)
      assert.deepEqual(Object.keys(request).sort(),['action','engine']);assert.equal(JSON.stringify(request).includes('user-private-key'),false)
      if(stall)return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))
      if(request.engine==='cursor'){
        if(request.action==='login')cursorReady=true
        return Response.json({engine:'cursor',state:cursorReady?'ready':'login-required',message:cursorReady?'Cursor ACP 已连上':'请通过官方浏览器登录',native:cursor()})
      }
      if(request.engine==='dsh'){
        if(request.action==='connect')dshReady=true
        return Response.json({engine:'dsh',state:dshReady?'ready':'configuration-required',message:'SDK 已初始化，凭据任务时核验',dsh:dsh(),...(request.action==='configure'?{url:'http://127.0.0.1:12345/?setup=fixture'}:{})})
      }
    }
    throw new Error('Unexpected request '+input)
  }) as typeof fetch
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,fetch:fetchFixture})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})}
  const settings=await import('../src/core/assistant-settings');const initial=settings.getAssistantSettings()
  settings.updateAssistantSettings({connectionMode:'native',api:{...initial.api,apiKey:'user-private-key'},modelEngine:'codex'})
  const {createRoot}=await import('react-dom/client'),{default:SettingsDialog}=await import('../src/components/SettingsDialog')
  const root=createRoot(dom.window.document.getElementById('root')!)
  await act(async()=>root.render(createElement(SettingsDialog,{projectId:'project-a',onClose(){},onOpenAppearance(){}})))
  const button=(label:string)=>{const found=dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="'+label+'"]');assert.ok(found,label);return found}
  return{dom,operations,settings,button,setStall(value:boolean){stall=value},async click(label:string){await act(async()=>button(label).click())},async close(){await act(async()=>root.unmount());settings.updateAssistantSettings(initial);dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}}}
}
test('Cursor one-click checks before explicit official login; success chooses engine and keeps API secrets',async()=>{
  const page=await fixture()
  try{
    await page.click('一键连接 Cursor CLI')
    assert.deepEqual(page.operations,[{engine:'cursor',action:'connect'}])
    assert.match(page.dom.window.document.querySelector('[aria-label="Cursor CLI 连接设置"]')!.textContent!,/官方浏览器登录/)
    assert.equal(page.settings.getAssistantSettings().modelEngine,'codex')
    await page.click('网页登录 Cursor CLI')
    assert.equal(page.settings.getAssistantSettings().modelEngine,'cursor')
    assert.equal(page.settings.getAssistantSettings().api.apiKey,'user-private-key')
    assert.match(page.dom.window.document.querySelector('[aria-label="Cursor CLI 连接设置"]')!.textContent!,/Cursor ACP 已连上/)
  }finally{await page.close()}
})
test('cancelling a connection releases UI busy state and retains native settings',async()=>{
  const page=await fixture()
  try{
    page.setStall(true)
    await act(async()=>page.button('一键连接 Cursor CLI').click())
    const cancel=[...page.dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent==='取消连接');assert.ok(cancel)
    await act(async()=>cancel.click())
    assert.equal(page.button('一键连接 Cursor CLI').disabled,false)
    assert.equal(page.settings.getAssistantSettings().modelEngine,'codex')
    assert.match(page.dom.window.document.querySelector('[aria-label="Cursor CLI 连接设置"]')!.textContent!,/连接已取消/)
  }finally{await page.close()}
})
test('DSH one-click updates selected configured provider; official settings is an independent explicit action',async()=>{
  const page=await fixture()
  try{
    assert.equal(page.operations.length,0)
    await page.click('一键连接 DSH')
    assert.equal(page.settings.getAssistantSettings().modelEngine,'dsh-local')
    assert.deepEqual(page.settings.getAssistantSettings().dshSelection,{provider:'deepseek-official',model:'example-model'})
    const configure=[...page.dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent==='官方模型设置');assert.ok(configure)
    await act(async()=>configure.click())
    const link=page.dom.window.document.querySelector<HTMLAnchorElement>('a[href^="http://127.0.0.1:12345/"]');assert.ok(link)
    assert.deepEqual(page.operations.at(-1),{engine:'dsh',action:'configure'})
  }finally{await page.close()}
})
