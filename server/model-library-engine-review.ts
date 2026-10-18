import { readFile,stat } from 'node:fs/promises'
import {join} from 'node:path'
import type {DeviceEngineReview} from '../src/core/device-library-profile'
const states=['load-passed','compatibility-error','compatibility-warning','needs-device-test']
const caches=new Map<string,{stamp:string;generation:string;rows:Map<string,DeviceEngineReview>}>()
/** Generated locally by the full audit; a report for a different immutable
 * generation cannot certify or block newly compiled definitions. */
export async function libraryEngineReviews(root:string,generation:string):Promise<ReadonlyMap<string,DeviceEngineReview>> {
  const path=join(root,'audits','engine-review.json'),empty=new Map<string,DeviceEngineReview>()
  try {
    const info=await stat(path)
    if(info.size>32*1024*1024)return empty
    const stamp=`${info.size}:${info.mtimeMs}`,old=caches.get(path)
    if(old?.stamp===stamp)return old.generation===generation?old.rows:empty
    const raw=JSON.parse(await readFile(path,'utf8'))
    if(!/^\d{13}-[a-f0-9-]{36}$/.test(raw.generation)||!Array.isArray(raw.rows)||raw.rows.length>128000||raw.total!==raw.rows.length||typeof raw.recordedAt!=='string'||!Number.isFinite(Date.parse(raw.recordedAt)))return empty
    const rows=new Map<string,DeviceEngineReview>()
    for(const row of raw.rows){
      if(!/^[a-f0-9]{64}$/.test(row.key)||rows.has(row.key)||!states.includes(row.status)||typeof row.reason!=='string'||row.reason.length>1600||typeof row.test!=='string'||row.test.length>300)return empty
      rows.set(row.key,{status:row.status,reason:row.reason,test:row.test,recordedAt:raw.recordedAt})
    }
    if(caches.size>3)caches.delete(caches.keys().next().value!)
    caches.set(path,{stamp,generation:raw.generation,rows})
    return raw.generation===generation?rows:empty
  }catch{return empty} // A missing review never becomes an invented passed check.
}
