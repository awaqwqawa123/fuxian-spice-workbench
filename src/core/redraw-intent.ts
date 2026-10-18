/** Feedback about the drawing should revise the last review candidate. */
export function isSchematicRedrawRequest(message: string): boolean {
  const text = message.trim().toLowerCase()
  if (/(?:不要|别|不用|无需|不想|先别|暂停).{0,6}(?:重画|重新画|重绘|重新绘制|重新排版|重排|布局|走线)/.test(text)) return false
  return /重(?:新)?(?:画|绘制|绘图|绘)|再画|重排|重新排版|重新布局|重新布线|重新走线|画得.*不|画的.*不|图.*(?:不好|太乱|不整齐)|(?:线|布局|排版).*(?:乱|不好|不整齐)|(?:绘图|原理图|电路图|这个图|这张图).{0,16}(?:有点问题|有问题|不符合|不合理|画错|绘错)/.test(text)
}

/** Classify the allowed scope of a Codex redraw; this never chooses its sender. */
export function isLayoutOnlyFeedback(message: string): boolean {
  let text = message.trim().toLowerCase()
  if (!isSchematicRedrawRequest(text)) return false
  // Keeping electrical data is a constraint, not an electrical edit. Restrict
  // this normalization to explicit fields and punctuation-bounded clauses.
  const fields = '(?:器件|元件|参数|数值|型号|模型|电气连接|接线|连接关系|拓扑|网络|电路功能)(?:[、和与及 ]*(?:器件|元件|参数|数值|型号|模型|电气连接|接线|连接关系|拓扑|网络|电路功能))*'
  text = text.replace(new RegExp(`(?:保持|保留)?${fields}(?:保持)?(?:不变|原样)`, 'g'), '')
    .replace(new RegExp(`(?:不要|不)(?:修改|改变|更改|动|改)${fields}`, 'g'), '')
  if (/解释|为什么|仿真|测试|验证|参数|数值|型号|模型|防反接|缓启动|电压|电流|电路功能|连接关系|拓扑|\b\d+(?:\.\d+)?\s*(?:v|a|w|hz|ohm|ω)\b/i.test(text)) return false
  if (/添加|删除|移除|去掉|替换|更换|换成|改成|改用|加个|加一|加上|换个|补上|接入|接上/.test(text)) return false
  // These verbs can change geometry or circuitry. Only their explicit geometry
  // usage is admitted; e.g. "增加器件间距" versus "增加一个电容".
  text = text.replace(/(?:增加|减少|修改|调整|优化)[^，。；;\n]{0,16}?(?:位置|间距|摆放|布局|排版|走线|布线|文字|标签|对齐|折弯|拐点|转弯|绕线)/g, '')
  if (/增加|减少|修改|调整|优化/.test(text)) return false
  return true
}
