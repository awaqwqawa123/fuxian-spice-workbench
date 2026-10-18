import {createHash} from 'node:crypto'
import {readFile,readdir,writeFile} from 'node:fs/promises'
import {join,relative} from 'node:path'
const root=process.env.SPICE_OWNED_MODEL_LIBRARY_DIR
if(!root)throw new Error('Set SPICE_OWNED_MODEL_LIBRARY_DIR to the original library root')
const vendor=join(root,'vendor/pspice'),files=[]
async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await visit(path);else if(entry.isFile()&&/\.lib$/i.test(entry.name)){
  const bytes=await readFile(path),text=bytes.toString('latin1'),models=[]
  for(const match of text.matchAll(/^[*]a Device model created by \S+ for (\S+) on [^\r\n]+\r?\n(?:\s*\r?\n)*[.]subckt\s+(\S+)/gim)){
    const part=match[1],id=match[2]
    if(id.toLowerCase()!==`awb${part}`.toLowerCase()||! /^[a-z0-9_][a-z0-9_.-]{0,39}$/i.test(part))continue
    models.push({id,part:part.toUpperCase()})
  }
  if(models.length)files.push({path:relative(vendor,path).replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex'),models})
}}}
await visit(join(vendor,'tools/pspice/library'))
files.sort((a,b)=>a.path.localeCompare(b.path))
await writeFile(new URL('../src/core/reviewed-pspice-public-identities.json',import.meta.url),JSON.stringify({version:1,evidence:'Exact original creation annotation identifies public part; declaration and electrical parameters remain unchanged',files},null,2)+'\n')
console.log(JSON.stringify({files:files.length,identities:files.reduce((n,file)=>n+file.models.length,0)}))
