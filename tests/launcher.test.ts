import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const helper = resolve('scripts/launcher-service.ps1')
const quote = (value:string) => `'${value.replaceAll("'", "''")}'`
async function powershell(script:string) {
  return run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000})
}
async function fixture(mode='recover',readyAfter=2) {
  const temporary=await mkdtemp(join(tmpdir(),'fuxian-launcher-'))
  const root=join(temporary,"中文 空间 & 'quoted' $notACall")
  await Promise.all(['scripts','runtime','dist'].map(directory=>mkdir(join(root,directory),{recursive:true})))
  await Promise.all([writeFile(join(root,'runtime/node.exe'),'fixture'),writeFile(join(root,'dist/index.html'),'fixture')])
  const scenario=join(root,'scenario.json'),callsPath=join(root,'calls.jsonl')
  await writeFile(scenario,JSON.stringify({mode,readyAfter}))
  await writeFile(join(root,'scripts/local-service.ps1'),'\ufeff'+String.raw`
param([string]$Action,[int]$Port,[string]$ProjectDirectory,[string]$NodeExecutable,[int]$TimeoutSeconds)
$ErrorActionPreference='Stop'
$scenario=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scenario.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$calls=Join-Path $PSScriptRoot '..\calls.jsonl'
@{action=$Action;port=$Port;project=$ProjectDirectory;node=$NodeExecutable;mode=$env:FUXIAN_MODE} | ConvertTo-Json -Compress | Add-Content -LiteralPath $calls -Encoding UTF8
if($scenario.mode -eq 'error'){throw 'Port is occupied by another program; no process was stopped.'}
$count=@(Get-Content -LiteralPath $calls).Count
$ready=$scenario.mode -eq 'ready' -or ($scenario.mode -eq 'recover' -and $count -gt $scenario.readyAfter)
@{running=$ready;managedHostRunning=$true;status=$(if($ready){'ready'}else{'recovering'});port=$(if($scenario.mode -eq 'mismatch'){$Port+1}else{$Port});serviceDirectory='retained fixture logs'} | ConvertTo-Json -Compress
`)
  return {root,scenario,async calls(){return(await readFile(callsPath,'utf8')).trim().replace(/^\ufeff/,'').split(/\r?\n/).map(line=>JSON.parse(line))},async close(){await rm(temporary,{recursive:true,force:true})}}
}
const invoke=(root:string,timeout=3)=>powershell(`& ${quote(helper)} -ProjectDirectory ${quote(root)} -Port 34567 -TimeoutSeconds ${timeout}`)

test('launcher keeps the UI worker asynchronous and waits through recovery before returning a browser target',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const f=await fixture()
  try{
    const {stdout}=await powershell(`$p=[PowerShell]::Create();$null=$p.AddCommand(${quote(helper)}).AddParameter('ProjectDirectory',${quote(f.root)}).AddParameter('Port',34567).AddParameter('TimeoutSeconds',3);$async=$p.BeginInvoke();if(!$async.IsCompleted){Write-Output 'ASYNC-WORKER-RETURNED'};$output=$p.EndInvoke($async);if($p.HadErrors){throw($p.Streams.Error|Out-String)};$output;$p.Dispose()`)
    assert.match(stdout,/ASYNC-WORKER-RETURNED/)
    const result=JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)
    assert.equal(result.ready,true);assert.equal(result.url,'http://localhost:34567/')
    const calls=await f.calls()
    assert.deepEqual(calls.map(call=>call.action),['Start','Status','Status'])
    for(const call of calls){assert.equal(call.project,f.root);assert.equal(call.node,join(f.root,'runtime/node.exe'));assert.equal(call.mode,'production')}
  } finally {await f.close()}
})
test('an already ready managed service opens without a second startup request',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture('ready')
  try{assert.equal(JSON.parse((await invoke(f.root)).stdout).ready,true);assert.deepEqual((await f.calls()).map(call=>call.action),['Start'])}
  finally{await f.close()}
})
test('launch errors remain actionable and a later retry succeeds without a forced stop',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture('error')
  try{
    await assert.rejects(invoke(f.root),/Port is occupied by another program/)
    await writeFile(f.scenario,JSON.stringify({mode:'ready'}))
    assert.equal(JSON.parse((await invoke(f.root)).stdout).ready,true)
    assert.deepEqual((await f.calls()).map(call=>call.action),['Start','Start'])
  }finally{await f.close()}
})
test('unready or mismatched services and incomplete extraction never report success',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const f=await fixture('never')
  try{
    await assert.rejects(invoke(f.root,2),/not ready yet/)
    await writeFile(f.scenario,JSON.stringify({mode:'mismatch'}))
    await assert.rejects(invoke(f.root),/mismatched status/)
    await rm(join(f.root,'runtime/node.exe'))
    await assert.rejects(invoke(f.root),/portable package is incomplete/)
  }finally{await f.close()}
})
test('launcher scripts parse in Windows PowerShell 5 and preserve UTF-8 Chinese labels',{skip:process.platform!=='win32'},async()=>{
  await powershell(`foreach($path in @(${quote(resolve('scripts/launcher.ps1'))},${quote(resolve('scripts/build-launcher.ps1'))},${quote(helper)})){$errors=$null;$tokens=$null;[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw($errors|Out-String)}}`)
  const ui=await readFile('scripts/launcher.ps1')
  assert.deepEqual([...ui.subarray(0,3)],[0xef,0xbb,0xbf])
  assert.match(await readFile('scripts/launcher.cs','utf8'),/启动软件/)
})
