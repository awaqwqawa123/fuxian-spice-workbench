import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
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

test('native shell route stages only the selected project and registers Open With without altering the default', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'fuxian-native-project-'))
  const root=join(temporary,"设备 中文 & 文件夹")
  const service=join(root,'service')
  const inbox=join(service,'open-project-inbox')
  await mkdir(inbox,{recursive:true})
  const executable=join(root,'Fuxian.exe'),helper=join(root,'helper.ps1'),project=join(root,'测试 工程 & 配置.FUXIAN')
  const shell=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe')
  const testRegistryKey='Software\\FuxianIntegrationTest-'+temporary.split(/[\\/]/).pop()
  const fakeProject=Buffer.from('synthetic model and schematic · 中文')
  const expired='0123456789abcdef'.repeat(2)+'.fuxian'
  const ignored='not-an-inbox-file.fuxian'
  await writeFile(join(inbox,expired),'expired')
  await utimes(join(inbox,expired),new Date(0),new Date(0))
  await writeFile(join(inbox,ignored),'unrelated')
  const tooLarge=join(root,'large.fuxian')
  await writeFile(tooLarge,'')
  await truncate(tooLarge,32*1024*1024+1)
  try{
    await run(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/build-launcher.ps1'),'-OutputPath',executable],{windowsHide:true,timeout:20000})
    await writeFile(project,fakeProject)
    await writeFile(helper,`param([int]$Port,[int]$TimeoutSeconds)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
'call' | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.txt')
@{ready=$true;port=$Port;url="http://localhost:$Port/";serviceDirectory=(Join-Path $PSScriptRoot 'service')} | ConvertTo-Json -Compress
`)
    const script=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$assembly=[Reflection.Assembly]::LoadFile(${quote(executable)})
$parsed=$assembly.GetType('FuxianLauncher.LauncherOptions').GetMethod('Parse').Invoke($null,@(,[string[]]@('--port','34568',${quote(project)})))
$start=$assembly.GetType('FuxianLauncher.ServiceLauncher').GetMethod('StartProject')
$url=$start.Invoke($null,@(${quote(helper)},$parsed.Port,$parsed.Timeout,$parsed.ProjectPath))
$failures=@{}
foreach($path in @('relative.fuxian',${quote(tooLarge)},${quote(join(root,'missing.fuxian'))})){
 try{$null=$start.Invoke($null,@(${quote(helper)},34568,3,$path));throw 'Unexpected success'}
 catch{$failures[[IO.Path]::GetFileName($path)]=$_.Exception.InnerException.Message}
}
$sandbox=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(testRegistryKey)})
try{
 $extension=$sandbox.CreateSubKey('Software\\Classes\\.fuxian')
 try{$extension.SetValue('', 'Already.Chosen')}finally{$extension.Dispose()}
 $setting=$assembly.GetType('FuxianLauncher.ProjectFileAssociation').GetMethod('Register').Invoke($null,@($sandbox,${quote(executable)}))
 function Get-RegistryValue($path,$name){
  $key=$sandbox.OpenSubKey($path)
  try {$key.GetValue($name)} finally {$key.Dispose()}
 }
 @{
  url=$url; failures=$failures; setting=$setting;
  command=Get-RegistryValue 'Software\\Classes\\Fuxian.Project\\shell\\open\\command' '';
  existing=Get-RegistryValue 'Software\\Classes\\.fuxian' '';
  openWith=Get-RegistryValue 'Software\\Classes\\.fuxian\\OpenWithProgids' 'Fuxian.Project';
  registered=Get-RegistryValue 'Software\\RegisteredApplications' '伏线 Fuxian';
  association=Get-RegistryValue 'Software\\Fuxian\\Capabilities\\FileAssociations' '.fuxian'
 } | ConvertTo-Json -Compress
}finally{
 $sandbox.Dispose()
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(testRegistryKey)},$false)
}
`
    const {stdout}=await run(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000})
    const result=JSON.parse(stdout.trim())
    assert.match(result.url,/^http:\/\/localhost:34568\/#openFuxian=[0-9a-f]{32}$/)
    const token=new URL(result.url).hash.slice('#openFuxian='.length)
    assert.deepEqual(await readFile(join(inbox,token+'.fuxian')),fakeProject)
    assert.deepEqual(await readFile(project),fakeProject)
    assert.ok(Date.now()-(await stat(join(inbox,token+'.fuxian'))).mtimeMs<60_000)
    assert.deepEqual((await readdir(inbox)).sort(),[token+'.fuxian',ignored].sort(),'no old token or partial file remains')
    assert.match(result.failures['relative.fuxian'],/完整路径/)
    assert.match(result.failures['large.fuxian'],/32 MB/)
    assert.match(result.failures['missing.fuxian'],/找不到/)
    assert.equal((await readFile(join(root,'calls.txt'),'utf8')).trim(),'call','bad files never start the service')
    assert.equal(result.setting,'ms-settings:defaultapps?registeredAppUser='+encodeURIComponent('伏线 Fuxian'))
    assert.equal(result.command,`"${executable}" "%1"`)
    assert.equal(result.existing,'Already.Chosen')
    assert.equal(result.registered,'Software\\Fuxian\\Capabilities')
    assert.equal(result.association,'Fuxian.Project')
  }finally{
    const within=relative(resolve(tmpdir()),resolve(temporary));assert.ok(within&&!isAbsolute(within)&&!within.startsWith('..'))
    await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:200})
  }
})
