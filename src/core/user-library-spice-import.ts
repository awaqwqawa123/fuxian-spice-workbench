import { decodeSpiceLibrary, SPICE_LIBRARY_LIMITS } from './spice-models'
import { parseModelLibraryPreview } from './model-library-preview'

export const USER_SPICE_FILE_ACCEPT = '.lib,.mod,.model,.cir,.sp,.spice,.spi,.inc,.ckt,.sub,.txt,.dio,.bjt,.mos'
export const USER_LIBRARY_CAPACITY = 256

export function previewUserLibrarySpiceFile(name: string, bytes: ArrayBuffer | Uint8Array) {
  if (!/\.(?:lib|mod|model|cir|sp|spice|spi|inc|ckt|sub|txt|dio|bjt|mos)$/i.test(name)) throw new Error('请选择 SPICE 模型文件（.lib、.mod、.cir、.sub 等）；JSON 备份请使用“导入备份”。')
  if (bytes.byteLength > SPICE_LIBRARY_LIMITS.fileBytes) throw new Error('SPICE 模型文件最多支持 4 MB，请先拆分大型库。')
  return parseModelLibraryPreview(decodeSpiceLibrary(bytes), { label: name.slice(0, 200) })
}
