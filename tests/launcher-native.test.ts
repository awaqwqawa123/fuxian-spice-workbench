import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const run=promisify(execFile)
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`
test('system Framework compiler builds a native GUI executable and its actual child process validates UTF-8 helper replies',{skip:process.platform!=='win32',timeout:40000},async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'fuxian-native-launcher-'))
  const root=join(temporary,"中文 空间 100% & 'launcher'")
  await mkdir(root)
  const executable=join(root,'Fuxian.exe'),helper=join(root,'helper.ps1')
  const shell=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe')
  try{
    await run(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/build-launcher.ps1'),'-OutputPath',executable],{windowsHide:true,timeout:20000})
    const pe=await readFile(executable),header=pe.readUInt32LE(0x3c)
    assert.equal(pe.subarray(0,2).toString(),'MZ')
    assert.equal(pe.readUInt16LE(header+4),0x8664,'launcher is a native x64 PE')
    assert.equal(pe.readUInt16LE(header+24+68),2,'Windows GUI subsystem cannot create a console window')
    await writeFile(helper,'\ufeff'+String.raw`
param([int]$Port,[int]$TimeoutSeconds)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$mode=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mode.txt'))
@{port=$Port;timeout=$TimeoutSeconds;directory=$PSScriptRoot;modulePath=$env:PSModulePath} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.jsonl') -Encoding UTF8
if($mode -eq 'error'){throw '中文诊断：端口被占用，服务没有被停止。'}
@{ready=($mode -ne 'unready');port=$(if($mode -eq 'badport'){$Port+1}else{$Port});url="http://localhost:$Port/"} | ConvertTo-Json -Compress
`)
    const script=`
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$assembly=[Reflection.Assembly]::LoadFile(${quote(executable)})
$start=$assembly.GetType('FuxianLauncher.ServiceLauncher').GetMethod('Start')
$mode=${quote(join(root,'mode.txt'))}
[IO.File]::WriteAllText($mode,'ready')
$url=$start.Invoke($null,@(${quote(helper)},34568,3))
$failures=@{}
foreach($kind in @('unready','badport','error')){
  [IO.File]::WriteAllText($mode,$kind)
  try{$null=$start.Invoke($null,@(${quote(helper)},34568,3));throw 'Unexpected success'}
  catch{$failures[$kind]=$_.Exception.InnerException.Message}
}
@{url=$url;failures=$failures} | ConvertTo-Json -Compress
`
    const {stdout}=await run(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000})
    const result=JSON.parse(stdout.trim())
    assert.equal(result.url,'http://localhost:34568/')
    assert.match(result.failures.unready,/就绪状态/)
    assert.match(result.failures.badport,/就绪状态/)
    assert.match(result.failures.error,/中文诊断：端口被占用/)
    const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).replace(/^\ufeff/,'').trim().split(/\r?\n/).map(line=>JSON.parse(line))
    assert.equal(calls.length,4)
    for(const call of calls){assert.equal(call.directory,root);assert.equal(call.port,34568);assert.equal(call.timeout,3);assert.match(call.modulePath,/WindowsPowerShell\\v1\.0\\Modules/i)}
  }finally{
    const within=relative(resolve(tmpdir()),resolve(temporary));assert.ok(within&&!isAbsolute(within)&&!within.startsWith('..'))
    await rm(temporary,{recursive:true,force:true})
  }
})
