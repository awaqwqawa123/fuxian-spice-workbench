// Runs only in the dedicated DSH child. The parent owns validation and ngspice.
export const name = 'fuxian-circuit-tools'
export const inject = ['tools']

export function renderCircuitToolResult(_args, value) {
  if (value && typeof value === 'object' && value.figure) {
    const { imageAttachment, figure, ...metadata } = value
    const { dataBase64: _encodedBytes, ...figureMetadata } = figure
    if (!imageAttachment) throw new Error('规格书曲线图片未存为 DSH 附件，不能仅以文字替代曲线图')
    return [{ type: 'text', text: JSON.stringify({ ...metadata, figure: figureMetadata }) }, { type: 'image', attachment: imageAttachment }]
  }
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export async function apply(ctx) {
  const endpoint = process.env.FUXIAN_CIRCUIT_BRIDGE
  const token = process.env.FUXIAN_CIRCUIT_TOKEN
  if (!endpoint || !token) throw new Error('Circuit bridge is unavailable')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const response = await fetch(`${endpoint}/tools`, { headers, redirect: 'error' })
  if (!response.ok) throw new Error('Circuit tools could not be loaded')
  const definitions = await response.json()
  for (const definition of definitions) {
    ctx.tools.register({
      ...definition,
      output: {
        schema: {},
        render: renderCircuitToolResult,
      },
      async execute(args, exec) {
        const reply = await fetch(`${endpoint}/tools/call`, {
          method: 'POST', headers, redirect: 'error', signal: exec.signal,
          body: JSON.stringify({ name: definition.name, input: args }),
        })
        const result = await reply.json()
        if (!reply.ok) throw new Error(result.error || 'Circuit tool failed')
        const value = result.value
        if (definition.name === 'view_datasheet_curve' && value?.figure) {
          const { figure, ...metadata } = value
          if (!['image/png', 'image/jpeg'].includes(figure.mimeType) || typeof figure.dataBase64 !== 'string' || !figure.dataBase64 || Buffer.from(figure.dataBase64, 'base64').toString('base64') !== figure.dataBase64 || Buffer.byteLength(figure.dataBase64, 'base64') > 700 * 1024) throw new Error('规格书曲线图片格式或大小不正确')
          const attachments = ctx.get('attachments')
          if (!attachments?.admitPromptContent) throw new Error('当前 DSH 运行时不支持图片附件，曲线图未发送到模型')
          const admitted = await attachments.admitPromptContent([{ type: 'image', mediaType: figure.mimeType, data: figure.dataBase64, name: `datasheet-page-${figure.page ?? 'curve'}` }])
          const image = admitted.find(part => part.type === 'image')
          if (!image?.attachment) throw new Error('DSH 未接收曲线图片附件')
          const { dataBase64: _encodedBytes, ...figureMetadata } = figure
          return { ...metadata, figure: figureMetadata, imageAttachment: image.attachment }
        }
        return value
      },
    })
  }
}
