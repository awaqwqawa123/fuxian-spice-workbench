import { MAX_PROJECT_FILE_BYTES, readProjectFile } from './project-file'

export function readLaunchToken(url: URL) {
  const prefix = '#openFuxian='
  if (!url.hash.startsWith(prefix)) return undefined
  return url.hash.slice(prefix.length)
}

export async function claimLaunchedProject(token: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('工程打开链接无效，请重新双击原文件。')
  const response = await fetch('/api/open-project-handoff', {
    method:'POST', credentials:'same-origin', cache:'no-store', headers:{'Content-Type':'application/json','x-fuxian-project-open':'1'},
    body:JSON.stringify({token}), signal,
  })
  if (!response.ok) throw new Error('打开请求已过期或已使用，请重新双击原文件或手动打开。')
  if (Number(response.headers.get('content-length')) > MAX_PROJECT_FILE_BYTES) throw new Error('工程文件超过 32 MB。')
  const blob = await response.blob()
  return readProjectFile({name:'工程.fuxian',size:blob.size,arrayBuffer:()=>blob.arrayBuffer(),text:()=>blob.text()})
}
