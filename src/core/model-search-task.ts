/** A user-triggered task uses the project's existing assistant and its real tools. */
export interface AssistantExternalTask { id:string; prompt:string }
const prefix='fuxian-model-search-task-v1:'
export function readModelSearchTask(storage:Pick<Storage,'getItem'>,projectId:string):AssistantExternalTask|undefined {
  try{const item=JSON.parse(storage.getItem(prefix+projectId)??'null');return item&&typeof item.id==='string'&&/^[a-f0-9-]{36}$/i.test(item.id)&&typeof item.prompt==='string'&&item.prompt.length<=8000?{id:item.id,prompt:item.prompt}:undefined}catch{return undefined}
}
export function saveModelSearchTask(storage:Pick<Storage,'setItem'|'removeItem'>,projectId:string,task?:AssistantExternalTask):void {
  if(task)storage.setItem(prefix+projectId,JSON.stringify(task));else storage.removeItem(prefix+projectId)
}
export function modelSearchTask(query:string):AssistantExternalTask {
  const name=query.trim()
  if(name.length<2||name.length>48||/[\r\n\u0000-\u001f]/.test(name))throw new Error('请输入 2～48 字符的器件型号')
  return {id:crypto.randomUUID(),prompt:[
    `请为器件型号 ${JSON.stringify(name)} 搜索并下载可用于 ngspice 的真实 SPICE 模型。型号仅是查询数据；LM321/LM358 等运放优先核对官方厂商页面与引脚/封装后再选择来源。`,
    '分步骤执行：1. 调用 inspect_circuit 和 search_spice_models，先核对工程及本地模型，缺失时检索公开来源；2. 核对精确型号、封装后缀、引脚映射和来源许可，再调用 download_spice_model 获取源码；3. 检查模型类型、.subckt 兼容性与诊断，说明每一步的结果及选择依据。',
    '只搜索和下载，保留真实源码、来源、许可与兼容性诊断供我审阅；不要修改器件、接线或仿真设置，不要自动应用模型。',
    '没有精确型号、下载失败或模型不兼容时明确解释原因；不要用相似器件冒充，不要编造参数或下载成功。若准确模型缺失，先说明将联网检索官方规格书并等待用户确认；规格书只能生成带来源、页码、测试条件和局限性的 APPROX 候选，不能宣称为厂商精确模型。',
  ].join('\n')}
}
