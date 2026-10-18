/** Metadata-only index from locally owned vendor originals. Never parses or
 * redistributes electrical implementations, or guesses a package pin order. */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { indexFunctionalPinEvidence } from '../src/core/model-pin-evidence'
import { classifyModelFunctionalSymbol } from '../src/core/model-functional-symbol'
import type { ImportedSpiceModel } from '../src/core/spice-models'

const originalRoot=path.resolve(process.argv[2]??'model-library/vendor')
const output=path.resolve(process.argv[3]??'src/core/reviewed-model-pin-evidence.json')
const vendors=[{vendor:'tina',root:'tina',prefix:'SPICELIB/',url:'https://www.ti.com/tool/TINA-TI'}, {vendor:'pspice',root:'pspice',prefix:'tools/pspice/library/',url:'https://www.cadence.com/en_US/home/tools/system-design-and-verification/analog-mixed-signal-simulation/pspice.html'}]
type Entry={id:string;ports:string[];roles?:string[];family?:string}
const files:{vendor:string;path:string;sha256:string;models:Entry[]}[]=[]
const stats:Record<string,{files:number;declarations:number;verified:number;families:Record<string,number>}>= {}
async function visit(folder:string):Promise<string[]>{
  const entries=await readdir(folder,{withFileTypes:true}), result:string[]=[]
  for(const entry of entries){const file=path.join(folder,entry.name);if(entry.isDirectory())result.push(...await visit(file));else if(/\.(?:lib|mod|cir)$/i.test(entry.name))result.push(file)}
  return result.sort()
}
for(const source of vendors){
  const root=path.join(originalRoot,source.root)
  const counts:{files:number;declarations:number;verified:number;families:Record<string,number>}=stats[source.vendor]={files:0,declarations:0,verified:0,families:{}}
  for(const file of await visit(path.join(root,source.prefix))){
    const data=await readFile(file),relative=path.relative(root,file).replaceAll('\\','/'),sha256=createHash('sha256').update(data).digest('hex')
    const text=new TextDecoder(data[0]===0xff&&data[1]===0xfe?'utf-16le':data[0]===0xfe&&data[1]===0xff?'utf-16be':'windows-1252').decode(data)
    const index=indexFunctionalPinEvidence(text),models:Entry[]=[]
    counts.files++;counts.declarations+=index.size
    for(const [id,evidence] of index){
      if(evidence.ports.length<2||evidence.ports.length>32)continue
      const model:ImportedSpiceModel={id,kind:'X',type:'SUBCKT',name:id,detail:'',pins:evidence.ports,spice:`.SUBCKT ${id} ${evidence.ports.join(' ')}\n.ENDS ${id}`,metadata:{},source:{label:`${source.vendor==='tina'?'TINA':'PSpice'} 本地库 / ${relative}`,url:source.url,attribution:`原文件 SHA-256：${sha256}`}}
      const classification=classifyModelFunctionalSymbol(model,index),family=classification.family
      if(!evidence.roles&&!family)continue
      models.push({id,ports:evidence.ports,...(evidence.roles?{roles:evidence.roles}:{}),...(family?{family}:{})})
      if(evidence.roles)counts.verified++
      const key=family??'unconfirmed-function';counts.families[key]=(counts.families[key]??0)+1
    }
    if(models.length)files.push({vendor:source.vendor,path:relative,sha256,models})
  }
}
await writeFile(output,JSON.stringify({version:1,files},null,2)+'\n')
console.log(JSON.stringify({output,files:files.length,stats},null,2))
