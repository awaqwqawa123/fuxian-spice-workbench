import type { ImportedSpiceModel } from './spice-models'
import { presentedModelSymbol } from './model-symbol-presentation'
import { classifyModelFunctionalSymbol } from './model-functional-symbol'

export function modelSymbolDescription(model: ImportedSpiceModel): string {
  const symbol=presentedModelSymbol(model)
  if(symbol?.shape==='box'&&symbol.origin==='standard')return '连接示意 · 保留已有接线'
  if (symbol?.shape === 'ltspice') return symbol.origin === 'standard'
    ? '标准功能符号 · 已对应电气引脚'
    : '原始器件符号 · 已对应电气引脚'
  if(model.kind!=='X')return '标准器件符号'
  const classification=classifyModelFunctionalSymbol(model)
  return classification.mapping==='verified'?`${classification.label} · 端口功能已核对；当前为连接示意`:`引脚连接示意 · ${classification.reason}`
}

/** Functional labels are display roles; original SPICE node identifiers remain
 * visible so no physical package numbering is implied by this display. */
export function modelTerminalDescription(model: ImportedSpiceModel): string {
  const symbol=presentedModelSymbol(model)
  return model.pins.map((raw, index) => {
    const label = symbol?.pins[index]?.label
    return `${index + 1}: ${label && label !== raw ? `${label}（${raw}）` : raw}`
  }).join(' · ')
}
