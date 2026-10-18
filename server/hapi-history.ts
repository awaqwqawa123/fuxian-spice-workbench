import type { HapiMessage } from '../src/core/hapi-types'
import { HapiError, parseHapiMessages, record } from './hapi-client'

type Position={seq:number;at:number}
export interface HapiHistory {sessionId:string;epoch:number;after:Position|null;before:Position|null;older:boolean}
const PAGE_LIMIT=200,PAGES_PER_POLL=8
export const HAPI_VISIBLE_MESSAGES=1000
const position=(seq:unknown,at:unknown):Position|null=>Number.isInteger(seq)&&typeof seq==='number'&&Number.isInteger(at)&&typeof at==='number'?{seq,at}:null
const newer=(a:Position,b:Position)=>a.at>b.at||a.at===b.at&&a.seq>b.seq
function mergeMessages(old:HapiMessage[],incoming:HapiMessage[]){
  const map=new Map(old.map(message=>[message.id,message]))
  for(const message of incoming)map.set(message.id,message)
  const ordered=[...map.values()].sort((a,b)=>a.createdAt-b.createdAt)
  let characters=0;const result:HapiMessage[]=[]
  for(let i=ordered.length-1;i>=0;i--){const message=ordered[i];if(result.length>=HAPI_VISIBLE_MESSAGES||characters+message.content.length>1_000_000)break;result.push(message);characters+=message.content.length}
  return result.reverse()
}

/** Persist composite cursors, not raw tool/token rows; epoch resets must remove stale history. */
export async function syncHapiHistory(client:{request:(path:string)=>Promise<any>},sessionId:string,previous:HapiHistory|undefined,cached:HapiMessage[]){
  let history=previous?.sessionId===sessionId?structuredClone(previous):undefined
  let messages=history?structuredClone(cached):[]
  const path=`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${PAGE_LIMIT}`
  const read=async(query='')=>{const response=await client.request(path+query);if(!Array.isArray(response.messages))throw new HapiError(502,'HAPI 聊天分页缺少消息数组');return{messages:parseHapiMessages(response.messages),page:record(response.page)}}
  const replace=(page:Record<string,any>,incoming:HapiMessage[])=>{
    history={sessionId,epoch:Number.isInteger(page.epoch)?page.epoch:0,after:position(page.snapshotHeadSeq,page.snapshotHeadAt),before:position(page.nextBeforeSeq,page.nextBeforeAt),older:page.hasMore===true}
    messages=mergeMessages([],incoming)
  }
  if(!history?.after){const response=await read();replace(response.page,response.messages)}
  else{
    let until:Position|null=null
    for(let count=0;count<PAGES_PER_POLL;count++){
      const from=history!.after!
      const response=await read(`&afterSeq=${from.seq}&afterAt=${from.at}&epoch=${history!.epoch}${until?`&untilSeq=${until.seq}&untilAt=${until.at}`:''}`)
      const page=response.page
      if(page.reset===true||page.direction==='latest'||Number.isInteger(page.epoch)&&page.epoch!==history!.epoch){replace(page,response.messages);break}
      messages=mergeMessages(messages,response.messages)
      const next=position(page.nextAfterSeq,page.nextAfterAt)
      if(page.hasMore===true&&(!next||!newer(next,from)))throw new HapiError(502,'HAPI 聊天分页游标没有前进；已停止重复读取')
      if(next&&newer(next,from))history!.after=next
      until??=position(page.snapshotHeadSeq,page.snapshotHeadAt)
      if(page.hasMore!==true)break
    }
  }
  // Tool-heavy turns may contain thousands of raw events. Continue old-page discovery
  // on subsequent polls until the visible conversation window is filled/exhausted.
  for(let count=0;count<PAGES_PER_POLL&&history!.older&&history!.before&&messages.length<HAPI_VISIBLE_MESSAGES;count++){
    const from=history!.before!,response=await read(`&beforeSeq=${from.seq}&beforeAt=${from.at}`),page=response.page
    if(page.reset===true||Number.isInteger(page.epoch)&&page.epoch!==history!.epoch){const latest=await read();replace(latest.page,latest.messages);break}
    const next=position(page.nextBeforeSeq,page.nextBeforeAt)
    if(page.hasMore===true&&(!next||!newer(from,next)))throw new HapiError(502,'HAPI 历史分页游标没有前进；已停止重复读取')
    messages=mergeMessages(response.messages,messages)
    history!.before=next;history!.older=page.hasMore===true
  }
  return{history:history!,messages}
}
