import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)
const quote=(text:string)=>`'${text.replaceAll("'","''")}'`
const hash=async(path:string)=>{const digest=createHash('sha256');for await(const part of createReadStream(path))digest.update(part);return digest.digest('hex').toUpperCase()}
test('Windows PowerShell hashes and retains a real Node runtime with no module lookup path',{skip:process.platform!=='win32',timeout:45000},async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'fuxian-runtime-'))
  const directory=join(temporary,"中文 空格 'hash' & runtime")
  await mkdir(directory)
  const fixture=join(directory,'hash-input.txt')
  await writeFile(fixture,'streamed SHA256 中文 fixture')
  const script=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
# Keep the base cmdlets a parent host already loaded, but make script-module
# discovery unavailable. An empty PSModulePath alone is rebuilt by WinPS.
Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1'))
Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'))
Remove-Item -LiteralPath Function:\Get-FileHash -ErrorAction SilentlyContinue
$env:PSModulePath=${quote(join(directory,'unavailable-modules'))}
$PSModuleAutoLoadingPreference='None'
. ${quote(resolve('scripts/local-service-runtime.ps1'))}
$serviceDirectory=${quote(directory)}
$first=Resolve-ServiceNode ${quote(process.execPath)}
$second=Resolve-ServiceNode ''
@{first=$first;second=$second;nodeHash=(Get-ServiceFileSha256 $first);fixtureHash=(Get-ServiceFileSha256 ${quote(fixture)});version=(Test-ServiceNode $second);fileHashAvailable=[bool](Get-Command Get-FileHash -ErrorAction SilentlyContinue)} | ConvertTo-Json -Compress
`
  try{
    const powershell=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe')
    const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:40000,env:{...process.env,PSModulePath:''}})
    const result=JSON.parse(stdout.trim()),expected=await hash(process.execPath)
    assert.equal(result.fileHashAvailable,false,'the regression must execute without the Get-FileHash module available')
    assert.equal(result.first,result.second,'saved runtime must work without discovering modules or another installation')
    assert.equal(result.nodeHash,expected)
    assert.equal(result.fixtureHash,await hash(fixture))
    assert.match(result.version,/^v\d+\.\d+\.\d+$/)
    assert.equal(result.first,join(directory,'runtime',expected,'node.exe'))
    const record=JSON.parse((await readFile(join(directory,'runtime.json'),'utf8')).replace(/^\ufeff/,''))
    assert.equal(record.sha256,expected);assert.equal(record.sourceExecutable,process.execPath)
    assert.equal(record.executable,result.first)
  }finally{
    const within=relative(resolve(tmpdir()),resolve(temporary))
    assert.ok(within&&!isAbsolute(within)&&!within.startsWith('..'),'cleanup must remain within the allocated temporary root')
    await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:200})
  }
})
