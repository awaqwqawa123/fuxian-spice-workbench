import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HapiMessage } from '../src/core/hapi-types'
import { HapiError, record } from './hapi-client'

export type HapiReceipt={id:string;hash:string;message:string;createdAt:number;delivery:NonNullable<HapiMessage['delivery']>;error?:string}

/** Completed request fingerprints stay on disk indefinitely; no 500-turn cutoff or replay gap. */
export class HapiReceiptStore{
  constructor(private readonly directory:string){}
  private file(projectId:string,id:string){const hash=createHash('sha256').update(id).digest('hex');return join(this.directory,'receipts',projectId,hash.slice(0,2),`${hash}.json`)}
  async read(projectId:string,id:string):Promise<HapiReceipt|null>{
    const file=this.file(projectId,id)
    try{
      if((await stat(file)).size>64000)throw new Error()
      const receipt=record(JSON.parse(await readFile(file,'utf8')))
      if(receipt.id!==id||typeof receipt.hash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.hash)||typeof receipt.createdAt!=='number'||!['queued','sent','unknown','failed'].includes(receipt.delivery))throw new Error()
      return receipt as HapiReceipt
    }catch(error){if(record(error).code==='ENOENT')return null;throw new HapiError(500,'发送凭据不可读；为避免重复执行，本次未重新发送')}
  }
  async write(projectId:string,receipt:HapiReceipt){
    const file=this.file(projectId,receipt.id);await mkdir(dirname(file),{recursive:true})
    const temp=`${file}.${randomUUID()}.tmp`
    // The content is only needed for unresolved/failed optimistic rows. The hash
    // permanently protects old request IDs after their chat leaves the hot window.
    const saved=receipt.delivery==='sent'?{...receipt,message:''}:receipt
    await writeFile(temp,JSON.stringify(saved),{mode:0o600});await rename(temp,file)
  }
}
export function compactHapiReceipts(receipts:HapiReceipt[]){
  const settled=receipts.filter(r=>r.delivery==='sent'||r.delivery==='failed').slice(-20),keep=new Set(settled.map(r=>r.id))
  return receipts.filter(r=>r.delivery==='queued'||r.delivery==='unknown'||keep.has(r.id))
}
